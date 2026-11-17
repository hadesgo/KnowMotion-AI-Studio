use crate::{
    job_object::ProcessJobObject,
    logging::{self, LogLevel},
    write_atomic,
};
use reqwest::{Client, Url};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashMap},
    env, fs,
    io::{BufRead, BufReader, Read},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex, OnceLock},
    thread,
    time::{Duration, Instant},
};
use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard};
use uuid::Uuid;

const DEFAULT_AUDIO_IDLE_SECONDS: u64 = 60;
const DEFAULT_DIFFUSION_IDLE_SECONDS: u64 = 120;
const DEFAULT_LLM_IDLE_SECONDS: u64 = 180;
const DEFAULT_VRAM_RESERVE_MIB: u64 = 896;
const MIN_VRAM_RESERVE_MIB: u64 = 768;
const MAX_VRAM_RESERVE_MIB: u64 = 1024;
const DEFAULT_VRAM_WAIT_SECONDS: u64 = 20;
const MAX_RUNTIME_LOG_BYTES: usize = 64 * 1024;

static SCHEDULER: OnceLock<Arc<LocalModelScheduler>> = OnceLock::new();
static SCHEDULER_DATA_ROOT: OnceLock<PathBuf> = OnceLock::new();

#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct LocalRuntimeConfig {
    /// audio.cpp model file/package directory. stable-diffusion.cpp may use this
    /// as a shorthand for a single diffusion model file.
    #[serde(default)]
    pub model_path: Option<String>,
    /// Model root passed to `sd-server --model-dir`.
    #[serde(default)]
    pub model_directory: Option<String>,
    /// Explicit audio.cpp family for models whose name is not self-describing.
    #[serde(default)]
    pub model_family: Option<String>,
    #[serde(default)]
    pub diffusion_model: Option<String>,
    #[serde(default)]
    pub text_encoder: Option<String>,
    /// Qwen3-VL 之类的视觉塔（`--llm_vision`）。Qwen Image 2.1 的编辑通道缺少它
    /// 会直接报 “editing requires Qwen3-VL vision weights”。
    #[serde(default)]
    pub llm_vision: Option<String>,
    #[serde(default)]
    pub vae: Option<String>,
    #[serde(default)]
    pub idle_unload_seconds: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Workload {
    Llm,
    Audio,
    Diffusion,
}

impl Workload {
    fn label(self) -> &'static str {
        match self {
            Self::Llm => "llm",
            Self::Audio => "audio",
            Self::Diffusion => "diffusion",
        }
    }

    fn display_label(self) -> &'static str {
        match self {
            Self::Llm => "LLM",
            Self::Audio => "audio.cpp",
            Self::Diffusion => "stable-diffusion.cpp",
        }
    }
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ActiveLeaseStatus {
    pub id: String,
    pub provider_id: String,
    pub workload: String,
    pub started_at: String,
    pub elapsed_ms: u128,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ManagedRuntimeStatus {
    pub key: String,
    pub runtime: String,
    pub base_url: String,
    pub model_loaded: bool,
    pub managed_process: bool,
    pub idle_seconds: u64,
    pub gpu_smoke_tested: bool,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct LocalModelSchedulerStatus {
    pub active_lease: Option<ActiveLeaseStatus>,
    pub waiting_requests: usize,
    pub vram_reserve_mib: u64,
    pub free_vram_mib: Option<u64>,
    pub managed_processes: usize,
    pub runtimes: Vec<ManagedRuntimeStatus>,
}

struct LeaseRecord {
    id: String,
    provider_id: String,
    workload: Workload,
    started: Instant,
    started_at: String,
}

struct RuntimeRecord {
    runtime: Workload,
    base_url: String,
    model_loaded: bool,
    managed_process: bool,
    idle_seconds: u64,
    last_used: Instant,
    gpu_smoke_tested: bool,
}

#[derive(Clone)]
struct AudioModelSpec {
    id: String,
    family: String,
    path: String,
    task: String,
}

#[derive(Clone)]
struct AudioRegistration {
    backend: String,
    idle_seconds: u64,
    models: BTreeMap<String, AudioModelSpec>,
}

#[derive(Clone, Default)]
struct DiffusionRegistration {
    backend: String,
    idle_seconds: u64,
    model_directory: Option<PathBuf>,
    diffusion_model: Option<PathBuf>,
    text_encoder: Option<PathBuf>,
    llm_vision: Option<PathBuf>,
    vae: Option<PathBuf>,
}

#[derive(Default)]
struct SchedulerState {
    active: Option<LeaseRecord>,
    waiting_requests: usize,
    free_vram_mib: Option<u64>,
    runtimes: HashMap<String, RuntimeRecord>,
    audio: HashMap<String, AudioRegistration>,
    diffusion: HashMap<String, DiffusionRegistration>,
}

struct ManagedProcess {
    signature: String,
    child: Child,
    job_object: ProcessJobObject,
    log: Arc<Mutex<String>>,
}

impl ManagedProcess {
    fn stop(&mut self) {
        let _ = self.job_object.terminate();
        let _ = self.child.kill();
        let _ = self.child.wait();
    }

    fn exit_status(&mut self) -> Option<String> {
        self.child
            .try_wait()
            .ok()
            .flatten()
            .map(|status| status.to_string())
    }

    fn log_tail(&self) -> String {
        self.log
            .lock()
            .map(|log| log.chars().rev().take(4000).collect::<String>())
            .map(|log| log.chars().rev().collect())
            .unwrap_or_default()
    }
}

impl Drop for ManagedProcess {
    fn drop(&mut self) {
        self.stop();
    }
}

struct LocalModelScheduler {
    gate: Arc<AsyncMutex<()>>,
    state: Mutex<SchedulerState>,
    processes: Mutex<HashMap<String, ManagedProcess>>,
}

pub(crate) struct GpuLease {
    scheduler: Option<Arc<LocalModelScheduler>>,
    gate: Option<OwnedMutexGuard<()>>,
    lease_id: String,
    runtime_key: Option<String>,
}

impl GpuLease {
    fn unmanaged() -> Self {
        Self {
            scheduler: None,
            gate: None,
            lease_id: String::new(),
            runtime_key: None,
        }
    }
}

impl Drop for GpuLease {
    fn drop(&mut self) {
        let Some(scheduler) = self.scheduler.take() else {
            return;
        };
        if let Ok(mut state) = scheduler.state.lock() {
            if state
                .active
                .as_ref()
                .is_some_and(|active| active.id == self.lease_id)
            {
                state.active = None;
            }
            if let Some(key) = self.runtime_key.as_ref() {
                if let Some(runtime) = state.runtimes.get_mut(key) {
                    runtime.last_used = Instant::now();
                }
            }
        }
        // Release the scheduling gate only after the active lease is visible as
        // finished, so a maintenance pass cannot unload underneath this request.
        self.gate.take();
    }
}

pub(crate) fn configure(data_root: PathBuf) {
    let _ = SCHEDULER_DATA_ROOT.set(data_root.join("scheduler"));
}

fn scheduler() -> Arc<LocalModelScheduler> {
    Arc::clone(SCHEDULER.get_or_init(|| {
        Arc::new(LocalModelScheduler {
            gate: Arc::new(AsyncMutex::new(())),
            state: Mutex::new(SchedulerState::default()),
            processes: Mutex::new(HashMap::new()),
        })
    }))
}

fn env_u64(name: &str, default: u64) -> u64 {
    env::var(name)
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(default)
}

fn vram_reserve_mib() -> u64 {
    env_u64("KNOWMOTION_VRAM_RESERVE_MIB", DEFAULT_VRAM_RESERVE_MIB)
        .clamp(MIN_VRAM_RESERVE_MIB, MAX_VRAM_RESERVE_MIB)
}

fn idle_seconds(runtime: Option<&LocalRuntimeConfig>, workload: Workload) -> u64 {
    runtime
        .and_then(|runtime| runtime.idle_unload_seconds)
        .unwrap_or(match workload {
            Workload::Llm => DEFAULT_LLM_IDLE_SECONDS,
            Workload::Audio => DEFAULT_AUDIO_IDLE_SECONDS,
            Workload::Diffusion => DEFAULT_DIFFUSION_IDLE_SECONDS,
        })
        .min(24 * 60 * 60)
}

pub(crate) fn is_loopback_base_url(value: &str) -> bool {
    let Ok(url) = Url::parse(value.trim()) else {
        return false;
    };
    if url.scheme() != "http" {
        return false;
    }
    if !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    let Some(host) = url.host_str() else {
        return false;
    };
    let normalized = host.trim_matches(['[', ']']);
    normalized.eq_ignore_ascii_case("localhost")
        || normalized
            .parse::<std::net::IpAddr>()
            .is_ok_and(|address| address.is_loopback())
}

pub(crate) async fn acquire_gpu(
    workload: Workload,
    provider_id: &str,
    base_url: &str,
    runtime: Option<&LocalRuntimeConfig>,
    backend: Option<&str>,
) -> Result<GpuLease, String> {
    if workload != Workload::Llm && !is_loopback_base_url(base_url) {
        return Ok(GpuLease::unmanaged());
    }

    let scheduler = scheduler();
    {
        let mut state = scheduler
            .state
            .lock()
            .map_err(|_| "Local model scheduler state is unavailable".to_string())?;
        state.waiting_requests += 1;
    }
    let gate = scheduler.gate.clone().lock_owned().await;
    {
        let mut state = scheduler
            .state
            .lock()
            .map_err(|_| "Local model scheduler state is unavailable".to_string())?;
        state.waiting_requests = state.waiting_requests.saturating_sub(1);
    }

    if let Err(error) = scheduler
        .prepare_for_lease(workload, provider_id, backend)
        .await
    {
        drop(gate);
        return Err(error);
    }

    let lease_id = Uuid::new_v4().to_string();
    let runtime_key = (workload != Workload::Llm)
        .then(|| runtime_key(workload, base_url))
        .or_else(|| Some(format!("llm:{provider_id}")));
    {
        let mut state = scheduler
            .state
            .lock()
            .map_err(|_| "Local model scheduler state is unavailable".to_string())?;
        state.active = Some(LeaseRecord {
            id: lease_id.clone(),
            provider_id: provider_id.to_string(),
            workload,
            started: Instant::now(),
            started_at: chrono::Utc::now().to_rfc3339(),
        });
        let key = runtime_key
            .clone()
            .unwrap_or_else(|| format!("llm:{provider_id}"));
        state.runtimes.insert(
            key,
            RuntimeRecord {
                runtime: workload,
                base_url: base_url.to_string(),
                model_loaded: true,
                managed_process: false,
                idle_seconds: idle_seconds(runtime, workload),
                last_used: Instant::now(),
                gpu_smoke_tested: false,
            },
        );
    }
    logging::log_event(
        LogLevel::Info,
        "local.models.lease",
        "GPU workload lease acquired",
        Some(json!({
            "workload": workload.label(),
            "providerId": provider_id,
            "reserveMiB": vram_reserve_mib()
        })),
    );
    Ok(GpuLease {
        scheduler: Some(scheduler),
        gate: Some(gate),
        lease_id,
        runtime_key,
    })
}

/// LLM 运行时是否已常驻（对应 provider 的 `llama-server` 仍在运行且模型已加载）。
/// 常驻时不需要再为新加载预留显存余量。
fn llm_runtime_is_resident(runtimes: &HashMap<String, RuntimeRecord>, provider_id: &str) -> bool {
    runtimes
        .get(&format!("llm:{provider_id}"))
        .is_some_and(|runtime| runtime.model_loaded)
}

impl LocalModelScheduler {
    async fn prepare_for_lease(
        &self,
        workload: Workload,
        provider_id: &str,
        backend: Option<&str>,
    ) -> Result<(), String> {
        match workload {
            Workload::Llm => {
                self.unload_runtime(Workload::Audio).await;
                self.unload_runtime(Workload::Diffusion).await;
            }
            Workload::Audio | Workload::Diffusion => {
                tokio::task::spawn_blocking(crate::agent::shutdown_llama_runtime)
                    .await
                    .map_err(|error| format!("Unable to stop idle llama.cpp runtime: {error}"))?;
                if let Ok(mut state) = self.state.lock() {
                    for runtime in state.runtimes.values_mut() {
                        if runtime.runtime == Workload::Llm {
                            runtime.model_loaded = false;
                        }
                    }
                }
                let competing = if workload == Workload::Audio {
                    Workload::Diffusion
                } else {
                    Workload::Audio
                };
                self.unload_runtime(competing).await;
            }
        }

        let use_gpu = !backend.is_some_and(|value| value.eq_ignore_ascii_case("cpu"));
        if use_gpu {
            // 已经常驻的 llama-server 自己就占着显存，再要求 896 MiB 空闲会让同一工作流
            // 的第二个 Agent 直接失败（“891 MiB free, 896 MiB required”）。只有确实要
            // 新加载模型时才检查余量。
            let resident = self
                .state
                .lock()
                .map(|state| llm_runtime_is_resident(&state.runtimes, provider_id))
                .unwrap_or(false);
            if !(workload == Workload::Llm && resident) {
                self.wait_for_vram_margin().await?;
            }
        }
        Ok(())
    }

    async fn unload_runtime(&self, workload: Workload) {
        let urls = {
            let state = match self.state.lock() {
                Ok(state) => state,
                Err(_) => return,
            };
            let mut urls = match workload {
                Workload::Audio => state.audio.keys().cloned().collect::<Vec<_>>(),
                Workload::Diffusion => state.diffusion.keys().cloned().collect::<Vec<_>>(),
                Workload::Llm => Vec::new(),
            };
            urls.sort();
            urls.dedup();
            urls
        };
        let client = scheduler_client();
        for url in urls {
            if url.is_empty() {
                continue;
            }
            let endpoint = match workload {
                Workload::Audio => format!("{url}/v1/tasks/unload_all_models"),
                Workload::Diffusion => format!("{url}/sdcpp/v1/models/unload"),
                Workload::Llm => continue,
            };
            let result = client.post(&endpoint).send().await;
            let loaded = match result {
                Ok(response) if response.status().is_success() => false,
                Ok(_) => true,
                Err(_) => false,
            };
            if let Ok(mut state) = self.state.lock() {
                if let Some(runtime) = state.runtimes.get_mut(&runtime_key(workload, &url)) {
                    runtime.model_loaded = loaded;
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }

    async fn wait_for_vram_margin(&self) -> Result<(), String> {
        let reserve = vram_reserve_mib();
        let Some(mut free) = tokio::task::spawn_blocking(nvidia_free_vram_mib)
            .await
            .ok()
            .flatten()
        else {
            return Ok(());
        };
        let deadline = Instant::now()
            + Duration::from_secs(
                env_u64("KNOWMOTION_VRAM_WAIT_SECONDS", DEFAULT_VRAM_WAIT_SECONDS).min(120),
            );
        loop {
            if let Ok(mut state) = self.state.lock() {
                state.free_vram_mib = Some(free);
            }
            if free >= reserve {
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err(format!(
                    "GPU memory safety margin is unavailable: {free} MiB free, {reserve} MiB required after unloading competing local models"
                ));
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
            free = nvidia_free_vram_mib().unwrap_or(free);
        }
    }

    async fn unload_idle_models(&self) {
        let Ok(_gate) = self.gate.clone().try_lock_owned() else {
            return;
        };

        let llm_idle = Duration::from_secs(env_u64(
            "KNOWMOTION_LLM_IDLE_SECONDS",
            DEFAULT_LLM_IDLE_SECONDS,
        ));
        let unloaded_llm =
            tokio::task::spawn_blocking(move || crate::agent::unload_idle_llama_runtime(llm_idle))
                .await
                .unwrap_or(0);
        if unloaded_llm > 0 {
            if let Ok(mut state) = self.state.lock() {
                for runtime in state.runtimes.values_mut() {
                    if runtime.runtime == Workload::Llm {
                        runtime.model_loaded = false;
                    }
                }
            }
        }

        let (audio_urls, diffusion_urls) = {
            let Ok(state) = self.state.lock() else {
                return;
            };
            let now = Instant::now();
            let mut audio = Vec::new();
            let mut diffusion = Vec::new();
            for (url, registration) in &state.audio {
                let key = runtime_key(Workload::Audio, url);
                if state.runtimes.get(&key).is_none_or(|runtime| {
                    now.duration_since(runtime.last_used).as_secs() >= registration.idle_seconds
                }) {
                    audio.push(url.clone());
                }
            }
            for (url, registration) in &state.diffusion {
                let key = runtime_key(Workload::Diffusion, url);
                if state.runtimes.get(&key).is_none_or(|runtime| {
                    now.duration_since(runtime.last_used).as_secs() >= registration.idle_seconds
                }) {
                    diffusion.push(url.clone());
                }
            }
            (audio, diffusion)
        };

        let client = scheduler_client();
        for url in audio_urls {
            let endpoint = format!("{url}/v1/tasks/unload_all_models");
            if client
                .post(endpoint)
                .send()
                .await
                .is_ok_and(|response| response.status().is_success())
            {
                if let Ok(mut state) = self.state.lock() {
                    if let Some(runtime) =
                        state.runtimes.get_mut(&runtime_key(Workload::Audio, &url))
                    {
                        runtime.model_loaded = false;
                    }
                }
                logging::log_event(
                    LogLevel::Info,
                    "local.models.idle",
                    "Idle audio.cpp models unloaded",
                    Some(json!({ "baseUrl": url })),
                );
            }
        }
        for url in diffusion_urls {
            let endpoint = format!("{url}/sdcpp/v1/models/unload");
            if client
                .post(endpoint)
                .send()
                .await
                .is_ok_and(|response| response.status().is_success())
            {
                if let Ok(mut state) = self.state.lock() {
                    if let Some(runtime) = state
                        .runtimes
                        .get_mut(&runtime_key(Workload::Diffusion, &url))
                    {
                        runtime.model_loaded = false;
                    }
                }
                logging::log_event(
                    LogLevel::Info,
                    "local.models.idle",
                    "Idle stable-diffusion.cpp model unloaded",
                    Some(json!({ "baseUrl": url })),
                );
            }
        }
    }

    fn status(&self) -> Result<LocalModelSchedulerStatus, String> {
        let (process_count, process_keys) = {
            let processes = self
                .processes
                .lock()
                .map_err(|_| "Local model process registry is unavailable".to_string())?;
            (
                processes.len(),
                processes.keys().cloned().collect::<Vec<_>>(),
            )
        };
        let state = self
            .state
            .lock()
            .map_err(|_| "Local model scheduler state is unavailable".to_string())?;
        let mut runtimes = state
            .runtimes
            .iter()
            .map(|(key, runtime)| ManagedRuntimeStatus {
                key: key.clone(),
                runtime: runtime.runtime.display_label().to_string(),
                base_url: runtime.base_url.clone(),
                model_loaded: runtime.model_loaded,
                managed_process: runtime.managed_process
                    || process_keys.iter().any(|process| process == key),
                idle_seconds: runtime.idle_seconds,
                gpu_smoke_tested: runtime.gpu_smoke_tested,
            })
            .collect::<Vec<_>>();
        runtimes.sort_by(|left, right| left.key.cmp(&right.key));
        Ok(LocalModelSchedulerStatus {
            active_lease: state.active.as_ref().map(|active| ActiveLeaseStatus {
                id: active.id.clone(),
                provider_id: active.provider_id.clone(),
                workload: active.workload.label().to_string(),
                started_at: active.started_at.clone(),
                elapsed_ms: active.started.elapsed().as_millis(),
            }),
            waiting_requests: state.waiting_requests,
            vram_reserve_mib: vram_reserve_mib(),
            free_vram_mib: state.free_vram_mib,
            managed_processes: process_count,
            runtimes,
        })
    }
}

pub(crate) async fn ensure_audio(
    _provider_id: &str,
    base_url: &str,
    model: &str,
    capability: &str,
    runtime: Option<&LocalRuntimeConfig>,
    backend: Option<&str>,
) -> Result<(), String> {
    if !is_loopback_base_url(base_url) {
        return Ok(());
    }
    let origin = normalize_origin(base_url);
    if origin.is_empty() {
        return Err("audio.cpp base URL must be a loopback HTTP endpoint".to_string());
    }
    let model_path = runtime
        .and_then(|runtime| runtime.model_path.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if let Some(path) = model_path {
        if !Path::new(path).exists() {
            return Err(format!(
                "audio.cpp model path does not exist: {}",
                Path::new(path).display()
            ));
        }
    }
    let family = runtime
        .and_then(|runtime| runtime.model_family.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| infer_audio_family(model, capability));
    let task = if capability.eq_ignore_ascii_case("ASR") {
        "asr"
    } else {
        "tts"
    };
    let backend = audio_backend(backend);
    let scheduler = scheduler();
    let key = runtime_key(Workload::Audio, &origin);
    {
        let mut state = scheduler
            .state
            .lock()
            .map_err(|_| "Local model scheduler state is unavailable".to_string())?;
        let registration = state
            .audio
            .entry(origin.clone())
            .or_insert_with(|| AudioRegistration {
                backend: backend.clone(),
                idle_seconds: idle_seconds(runtime, Workload::Audio),
                models: BTreeMap::new(),
            });
        registration.backend = backend.clone();
        registration.idle_seconds = idle_seconds(runtime, Workload::Audio);
        registration.models.insert(
            model.to_string(),
            AudioModelSpec {
                id: model.to_string(),
                family,
                path: model_path.unwrap_or_default().to_string(),
                task: task.to_string(),
            },
        );
        let record = state
            .runtimes
            .entry(key.clone())
            .or_insert_with(|| RuntimeRecord {
                runtime: Workload::Audio,
                base_url: origin.clone(),
                model_loaded: false,
                managed_process: false,
                idle_seconds: idle_seconds(runtime, Workload::Audio),
                last_used: Instant::now(),
                gpu_smoke_tested: false,
            });
        record.last_used = Instant::now();
        record.idle_seconds = idle_seconds(runtime, Workload::Audio);
    }

    let process_signature = audio_signature(&scheduler, &origin)?;
    let managed_signature = scheduler
        .processes
        .lock()
        .ok()
        .and_then(|processes| processes.get(&key).map(|process| process.signature.clone()));
    if managed_signature.is_some() && managed_signature.as_deref() != Some(&process_signature) {
        stop_managed_process(&scheduler, &key);
    }

    let health_url = format!("{origin}/health");
    let healthy = scheduler_client()
        .get(&health_url)
        .send()
        .await
        .is_ok_and(|response| response.status().is_success());
    if healthy && audio_has_model(&origin, model).await {
        mark_runtime_loaded(&scheduler, &key, false);
        return Ok(());
    }

    if healthy {
        return Err(format!(
            "audio.cpp is running at {origin}, but model '{model}' is not registered. The app only restarts servers it started itself."
        ));
    }

    if model_path.is_none() {
        return Err(format!(
            "audio.cpp is not running at {origin}. Choose a local model path in Models so KnowMotion can start it automatically."
        ));
    }
    start_audio_server(&scheduler, &origin, &key, model, task).await?;
    if !audio_has_model(&origin, model).await {
        return Err(format!(
            "audio.cpp started, but model '{model}' was not registered by the generated config"
        ));
    }
    mark_runtime_loaded(&scheduler, &key, true);
    Ok(())
}

fn audio_signature(scheduler: &Arc<LocalModelScheduler>, origin: &str) -> Result<String, String> {
    let state = scheduler
        .state
        .lock()
        .map_err(|_| "Local model scheduler state is unavailable".to_string())?;
    let registration = state
        .audio
        .get(origin)
        .ok_or_else(|| "audio.cpp registration is missing".to_string())?;
    serde_json::to_string(&json!({
        "backend": registration.backend,
        "models": registration.models.values().map(|model| json!({
            "id": model.id,
            "family": model.family,
            "path": model.path,
            "task": model.task
        })).collect::<Vec<_>>()
    }))
    .map_err(|error| error.to_string())
}

async fn start_audio_server(
    scheduler: &Arc<LocalModelScheduler>,
    origin: &str,
    key: &str,
    model: &str,
    task: &str,
) -> Result<(), String> {
    let data_root = scheduler_data_root()?;
    fs::create_dir_all(&data_root).map_err(|error| error.to_string())?;
    let (registration, port) = {
        let state = scheduler
            .state
            .lock()
            .map_err(|_| "Local model scheduler state is unavailable".to_string())?;
        let registration = state
            .audio
            .get(origin)
            .cloned()
            .ok_or_else(|| "audio.cpp registration is missing".to_string())?;
        (registration, endpoint_port(origin)?)
    };
    let smoke_on_gpu = registration.backend != "cpu";
    let models = registration
        .models
        .values()
        .map(|model| {
            json!({
                "id": model.id,
                "family": model.family,
                "path": model.path,
                "task": model.task,
                "mode": "offline"
            })
        })
        .collect::<Vec<_>>();
    let config = json!({
        "host": "127.0.0.1",
        "port": port,
        "backend": registration.backend,
        "lazy_load": true,
        "max_loaded_models": 1,
        "models": models
    });
    let config_path = data_root.join(format!("audio-{port}.json"));
    write_atomic(
        &config_path,
        serde_json::to_vec_pretty(&config)
            .map_err(|error| error.to_string())?
            .as_slice(),
    )?;
    let executable = PathBuf::from(
        crate::local_runtime::ensure_local_runtime("audio.cpp".to_string())
            .await?
            .executable_path,
    );
    let signature = audio_signature(scheduler, origin)?;
    let process = spawn_managed_process(
        Workload::Audio,
        &executable,
        &[
            "--config",
            config_path.to_string_lossy().as_ref(),
            "--no-ui",
        ],
        signature,
    )?;
    scheduler
        .processes
        .lock()
        .map_err(|_| "Local model process registry is unavailable".to_string())?
        .insert(key.to_string(), process);
    if let Err(error) = wait_for_audio_ready(scheduler, key, origin).await {
        stop_managed_process(scheduler, key);
        return Err(error);
    }
    if let Err(error) = run_audio_gpu_smoke(origin, model, task).await {
        stop_managed_process(scheduler, key);
        return Err(format!("audio.cpp runtime smoke test failed: {error}"));
    }
    if smoke_on_gpu {
        mark_runtime_smoke_tested(scheduler, key);
    }
    logging::log_event(
        LogLevel::Info,
        "local.models.audio",
        "audio.cpp server started",
        Some(json!({ "baseUrl": origin, "config": config_path })),
    );
    Ok(())
}

async fn wait_for_audio_ready(
    scheduler: &Arc<LocalModelScheduler>,
    key: &str,
    origin: &str,
) -> Result<(), String> {
    let timeout = env_u64("KNOWMOTION_AUDIO_START_TIMEOUT_SECONDS", 300);
    let deadline = Instant::now() + Duration::from_secs(timeout);
    let client = scheduler_client();
    while Instant::now() < deadline {
        if client
            .get(format!("{origin}/health"))
            .send()
            .await
            .is_ok_and(|response| response.status().is_success())
        {
            return Ok(());
        }
        if let Some(status) = managed_exit_status(scheduler, key) {
            let log = managed_log_tail(scheduler, key);
            return Err(format!(
                "audio.cpp exited during startup ({status}){}",
                if log.is_empty() {
                    String::new()
                } else {
                    format!(": {log}")
                }
            ));
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    Err(format!(
        "audio.cpp did not become ready within {timeout} seconds"
    ))
}

/// Execute one tiny inference after an app-managed audio.cpp process starts.
/// A `/health` response only proves that the HTTP server exists; this verifies
/// that the selected model can actually load and execute on the configured
/// Vulkan/CUDA backend.
async fn run_audio_gpu_smoke(origin: &str, model: &str, task: &str) -> Result<(), String> {
    if task.eq_ignore_ascii_case("asr") {
        run_audio_asr_smoke(origin, model).await
    } else {
        run_audio_tts_smoke(origin, model).await
    }
}

async fn run_audio_tts_smoke(origin: &str, model: &str) -> Result<(), String> {
    let response = scheduler_client()
        .post(format!("{origin}/v1/audio/speech"))
        .json(&json!({
            "model": model,
            "input": "测试",
            "voice": "serena"
        }))
        .send()
        .await
        .map_err(|error| format!("TTS probe request failed: {error}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("TTS probe returned {status}"));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("TTS probe response failed: {error}"))?;
    if bytes.len() <= 44 || !bytes.starts_with(b"RIFF") || bytes.get(8..12) != Some(b"WAVE") {
        return Err("TTS probe did not return a non-empty WAV file".to_string());
    }
    Ok(())
}

fn silent_wav() -> Vec<u8> {
    const SAMPLE_RATE: u32 = 16_000;
    const SAMPLE_COUNT: u32 = 4_000;
    const CHANNELS: u16 = 1;
    const BITS: u16 = 16;
    let data_bytes = SAMPLE_COUNT * CHANNELS as u32 * (BITS as u32 / 8);
    let byte_rate = SAMPLE_RATE * CHANNELS as u32 * (BITS as u32 / 8);
    let mut wav = Vec::with_capacity(44 + data_bytes as usize);
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(36 + data_bytes).to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt ");
    wav.extend_from_slice(&16_u32.to_le_bytes());
    wav.extend_from_slice(&1_u16.to_le_bytes());
    wav.extend_from_slice(&CHANNELS.to_le_bytes());
    wav.extend_from_slice(&SAMPLE_RATE.to_le_bytes());
    wav.extend_from_slice(&byte_rate.to_le_bytes());
    wav.extend_from_slice(&(CHANNELS * (BITS / 8)).to_le_bytes());
    wav.extend_from_slice(&BITS.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&data_bytes.to_le_bytes());
    wav.resize(44 + data_bytes as usize, 0);
    wav
}

async fn run_audio_asr_smoke(origin: &str, model: &str) -> Result<(), String> {
    let boundary = format!("knowmotion-smoke-{}", Uuid::new_v4().simple());
    let audio = silent_wav();
    let mut body = Vec::new();
    body.extend_from_slice(
        format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"model\"\r\n\r\n{model}\r\n"
        )
        .as_bytes(),
    );
    body.extend_from_slice(
        format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"smoke.wav\"\r\nContent-Type: audio/wav\r\n\r\n"
        )
        .as_bytes(),
    );
    body.extend_from_slice(&audio);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    let response = scheduler_client()
        .post(format!("{origin}/v1/audio/transcriptions/details"))
        .header(
            reqwest::header::CONTENT_TYPE,
            format!("multipart/form-data; boundary={boundary}"),
        )
        .body(body)
        .send()
        .await
        .map_err(|error| format!("ASR probe request failed: {error}"))?;
    let status = response.status();
    let payload: Value = response
        .json()
        .await
        .map_err(|_| format!("ASR probe returned a non-JSON response ({status})"))?;
    if !status.is_success() {
        return Err(format!("ASR probe returned {status}"));
    }
    if payload.get("text").and_then(Value::as_str).is_none() {
        return Err("ASR probe response has no text field".to_string());
    }
    Ok(())
}

pub(crate) async fn ensure_diffusion(
    _provider_id: &str,
    base_url: &str,
    runtime: Option<&LocalRuntimeConfig>,
    backend: Option<&str>,
) -> Result<(), String> {
    if !is_loopback_base_url(base_url) {
        return Ok(());
    }
    let origin = normalize_origin(base_url);
    if origin.is_empty() {
        return Err("stable-diffusion.cpp base URL must be a loopback HTTP endpoint".to_string());
    }
    let registration = diffusion_registration(runtime, backend)?;
    let has_startup_model = registration.diffusion_model.is_some();
    let scheduler = scheduler();
    let key = runtime_key(Workload::Diffusion, &origin);
    {
        let mut state = scheduler
            .state
            .lock()
            .map_err(|_| "Local model scheduler state is unavailable".to_string())?;
        let idle = idle_seconds(runtime, Workload::Diffusion);
        state.diffusion.insert(origin.clone(), registration.clone());
        let record = state
            .runtimes
            .entry(key.clone())
            .or_insert_with(|| RuntimeRecord {
                runtime: Workload::Diffusion,
                base_url: origin.clone(),
                model_loaded: false,
                managed_process: false,
                idle_seconds: idle,
                last_used: Instant::now(),
                gpu_smoke_tested: false,
            });
        record.last_used = Instant::now();
        record.idle_seconds = idle;
    }

    let signature = diffusion_signature(&registration)?;
    let managed_signature = scheduler
        .processes
        .lock()
        .ok()
        .and_then(|processes| processes.get(&key).map(|process| process.signature.clone()));
    if managed_signature.is_some() && managed_signature.as_deref() != Some(&signature) {
        stop_managed_process(&scheduler, &key);
    }

    let status_url = format!("{origin}/sdcpp/v1/models/status");
    let status = probe_json(&status_url).await;
    if let Some(status) = status.as_ref() {
        let state_name = status
            .get("state")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if state_name == "ready" {
            mark_runtime_loaded(&scheduler, &key, false);
            return Ok(());
        }
        if state_name == "loading" {
            wait_for_diffusion_ready(&scheduler, &key, &origin).await?;
            mark_runtime_loaded(&scheduler, &key, false);
            return Ok(());
        }
    }

    let managed_signature = scheduler
        .processes
        .lock()
        .ok()
        .and_then(|processes| processes.get(&key).map(|process| process.signature.clone()));
    if status.is_some() {
        if managed_signature.is_some() {
            // The process can remain alive after an idle unload. Restarting it
            // applies the configured startup model without requiring a manual
            // WebUI selection.
            stop_managed_process(&scheduler, &key);
        } else if !has_startup_model {
            return Err(format!(
                "stable-diffusion.cpp is running at {origin}, but no model is loaded. Select a model directory in Models so KnowMotion can start and preload it automatically."
            ));
        } else {
            return Err(format!(
                "stable-diffusion.cpp is running at {origin}, but its loaded model is unavailable. Close the externally started server or choose a different local port."
            ));
        }
    }

    if !has_startup_model {
        return Err(format!(
            "stable-diffusion.cpp is not running at {origin}. Select a model directory in Models so KnowMotion can start it automatically."
        ));
    }
    start_diffusion_server(&scheduler, &origin, &key, &registration, &signature).await?;
    wait_for_diffusion_ready(&scheduler, &key, &origin).await?;
    if let Err(error) = run_diffusion_gpu_smoke(&origin).await {
        stop_managed_process(&scheduler, &key);
        return Err(format!(
            "stable-diffusion.cpp runtime smoke test failed: {error}"
        ));
    }
    if registration.backend != "cpu" {
        mark_runtime_smoke_tested(&scheduler, &key);
    }
    mark_runtime_loaded(&scheduler, &key, true);
    Ok(())
}

fn diffusion_registration(
    runtime: Option<&LocalRuntimeConfig>,
    backend: Option<&str>,
) -> Result<DiffusionRegistration, String> {
    let backend = audio_backend(backend);
    let idle_seconds = idle_seconds(runtime, Workload::Diffusion);
    let mut registration = DiffusionRegistration {
        backend,
        idle_seconds,
        ..DiffusionRegistration::default()
    };
    let model_path = runtime
        .and_then(|runtime| runtime.model_path.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let model_directory = runtime
        .and_then(|runtime| runtime.model_directory.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if let Some(directory) = model_directory {
        let path = PathBuf::from(directory);
        if !path.is_dir() {
            return Err(format!(
                "stable-diffusion.cpp model directory does not exist: {}",
                path.display()
            ));
        }
        registration.model_directory = Some(path);
    }
    if let Some(path) = model_path {
        let path = PathBuf::from(path);
        if !path.exists() {
            return Err(format!(
                "stable-diffusion.cpp model path does not exist: {}",
                path.display()
            ));
        }
        if path.is_dir() {
            registration.model_directory.get_or_insert(path);
        } else {
            registration.diffusion_model = Some(path);
        }
    }
    registration.diffusion_model = explicit_or_discover(
        runtime.and_then(|runtime| runtime.diffusion_model.as_deref()),
        registration.model_directory.as_deref(),
        ModelRole::Diffusion,
    )?
    .or(registration.diffusion_model);
    registration.text_encoder = explicit_or_discover(
        runtime.and_then(|runtime| runtime.text_encoder.as_deref()),
        registration.model_directory.as_deref(),
        ModelRole::TextEncoder,
    )?;
    registration.llm_vision = explicit_or_discover(
        runtime.and_then(|runtime| runtime.llm_vision.as_deref()),
        registration.model_directory.as_deref(),
        ModelRole::Vision,
    )?;
    registration.vae = explicit_or_discover(
        runtime.and_then(|runtime| runtime.vae.as_deref()),
        registration.model_directory.as_deref(),
        ModelRole::Vae,
    )?;
    Ok(registration)
}

#[derive(Clone, Copy)]
enum ModelRole {
    Diffusion,
    TextEncoder,
    Vision,
    Vae,
}

fn explicit_or_discover(
    explicit: Option<&str>,
    root: Option<&Path>,
    role: ModelRole,
) -> Result<Option<PathBuf>, String> {
    if let Some(path) = explicit.map(str::trim).filter(|value| !value.is_empty()) {
        let path = PathBuf::from(path);
        if !path.is_file() {
            return Err(format!(
                "stable-diffusion.cpp model component does not exist: {}",
                path.display()
            ));
        }
        return Ok(Some(path));
    }
    Ok(root.and_then(|root| discover_model_component(root, role)))
}

fn discover_model_component(root: &Path, role: ModelRole) -> Option<PathBuf> {
    let mut files = Vec::new();
    collect_model_files(root, 0, &mut files);
    files.sort();
    files.into_iter().find(|path| {
        let normalized = path
            .to_string_lossy()
            .replace('\\', "/")
            .to_ascii_lowercase();
        match role {
            ModelRole::Diffusion => {
                (normalized.contains("/diffusion_models/")
                    || normalized.contains("/checkpoints/")
                    || normalized.contains("/stable-diffusion/"))
                    && (normalized.ends_with(".gguf")
                        || normalized.ends_with(".safetensors")
                        || normalized.ends_with(".ckpt"))
            }
            ModelRole::TextEncoder => {
                normalized.contains("/text_encoders/")
                    && (normalized.ends_with(".gguf") || normalized.ends_with(".safetensors"))
            }
            ModelRole::Vision => {
                let name = normalized.rsplit('/').next().unwrap_or_default();
                (name.contains("mmproj") || name.contains("vision"))
                    && normalized.ends_with(".gguf")
            }
            ModelRole::Vae => {
                normalized.contains("/vae/")
                    && (normalized.ends_with(".safetensors")
                        || normalized.ends_with(".gguf")
                        || normalized.ends_with(".sft"))
            }
        }
    })
}

fn collect_model_files(root: &Path, depth: usize, files: &mut Vec<PathBuf>) {
    if depth > 4 {
        return;
    }
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_model_files(&path, depth + 1, files);
        } else if path.is_file() {
            files.push(path);
        }
    }
}

fn diffusion_signature(registration: &DiffusionRegistration) -> Result<String, String> {
    serde_json::to_string(&json!({
        "directory": registration.model_directory,
        "diffusionModel": registration.diffusion_model,
        "textEncoder": registration.text_encoder,
        "llmVision": registration.llm_vision,
        "vae": registration.vae,
        "backend": registration.backend
    }))
    .map_err(|error| error.to_string())
}

async fn start_diffusion_server(
    scheduler: &Arc<LocalModelScheduler>,
    origin: &str,
    key: &str,
    registration: &DiffusionRegistration,
    signature: &str,
) -> Result<(), String> {
    let executable = PathBuf::from(
        crate::local_runtime::ensure_local_runtime("stable-diffusion.cpp".to_string())
            .await?
            .executable_path,
    );
    let port = endpoint_port(origin)?;
    let mut arguments = vec![
        "--listen-ip".to_string(),
        "127.0.0.1".to_string(),
        "--listen-port".to_string(),
        port.to_string(),
    ];
    if let Some(directory) = registration.model_directory.as_ref() {
        arguments.push("--model-dir".to_string());
        arguments.push(directory.to_string_lossy().to_string());
    }
    if let Some(model) = registration.diffusion_model.as_ref() {
        arguments.push("--diffusion-model".to_string());
        arguments.push(model.to_string_lossy().to_string());
    }
    if let Some(encoder) = registration.text_encoder.as_ref() {
        arguments.push("--llm".to_string());
        arguments.push(encoder.to_string_lossy().to_string());
    }
    if let Some(vision) = registration.llm_vision.as_ref() {
        arguments.push("--llm_vision".to_string());
        arguments.push(vision.to_string_lossy().to_string());
    }
    if let Some(vae) = registration.vae.as_ref() {
        arguments.push("--vae".to_string());
        arguments.push(vae.to_string_lossy().to_string());
    }
    if registration.backend == "cpu" {
        arguments.push("--backend".to_string());
        arguments.push("cpu".to_string());
    }
    let args = arguments.iter().map(String::as_str).collect::<Vec<_>>();
    let process = spawn_managed_process(
        Workload::Diffusion,
        &executable,
        &args,
        signature.to_string(),
    )?;
    scheduler
        .processes
        .lock()
        .map_err(|_| "Local model process registry is unavailable".to_string())?
        .insert(key.to_string(), process);
    logging::log_event(
        LogLevel::Info,
        "local.models.diffusion",
        "stable-diffusion.cpp server starting",
        Some(json!({
            "baseUrl": origin,
            "diffusionModel": registration.diffusion_model,
            "textEncoder": registration.text_encoder,
            "llmVision": registration.llm_vision,
            "vae": registration.vae
        })),
    );
    Ok(())
}

async fn wait_for_diffusion_ready(
    scheduler: &Arc<LocalModelScheduler>,
    key: &str,
    origin: &str,
) -> Result<(), String> {
    let timeout = env_u64("KNOWMOTION_DIFFUSION_START_TIMEOUT_SECONDS", 600);
    let deadline = Instant::now() + Duration::from_secs(timeout);
    while Instant::now() < deadline {
        if let Some(status) = probe_json(&format!("{origin}/sdcpp/v1/models/status")).await {
            match status.get("state").and_then(Value::as_str) {
                Some("ready") => return Ok(()),
                Some("error") => {
                    return Err(format!(
                        "stable-diffusion.cpp could not load the model: {}",
                        status
                            .get("error")
                            .and_then(Value::as_str)
                            .unwrap_or("unknown model loading error")
                    ))
                }
                _ => {}
            }
        }
        if let Some(status) = managed_exit_status(scheduler, key) {
            let log = managed_log_tail(scheduler, key);
            return Err(format!(
                "stable-diffusion.cpp exited during startup ({status}){}",
                if log.is_empty() {
                    String::new()
                } else {
                    format!(": {log}")
                }
            ));
        }
        tokio::time::sleep(Duration::from_millis(400)).await;
    }
    Err(format!(
        "stable-diffusion.cpp did not finish loading the model within {timeout} seconds"
    ))
}

async fn run_diffusion_gpu_smoke(origin: &str) -> Result<(), String> {
    let client = scheduler_client();
    let response = client
        .post(format!("{origin}/sdcpp/v1/img_gen"))
        .json(&json!({
            "prompt": "A simple blue circle on a white background",
            "negative_prompt": "text, watermark",
            "width": 256,
            "height": 256,
            "batch_count": 1,
            "sample_steps": 1,
            "seed": 1,
            "output_format": "png"
        }))
        .send()
        .await
        .map_err(|error| format!("image probe request failed: {error}"))?;
    let status = response.status();
    let mut payload: Value = response
        .json()
        .await
        .map_err(|_| format!("image probe returned a non-JSON response ({status})"))?;
    if !status.is_success() {
        return Err(format!("image probe returned {status}"));
    }
    let deadline = Instant::now() + Duration::from_secs(120);
    loop {
        if let Some(images) = payload.pointer("/result/images").and_then(Value::as_array) {
            if images.is_empty() {
                return Err("image probe completed without an image".to_string());
            }
            let encoded = images[0]
                .get("b64_json")
                .and_then(Value::as_str)
                .ok_or_else(|| "image probe result has no b64_json".to_string())?;
            use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
            let payload = encoded
                .split_once(',')
                .map(|(_, payload)| payload)
                .unwrap_or(encoded);
            let bytes = BASE64
                .decode(payload)
                .map_err(|error| format!("image probe returned invalid base64: {error}"))?;
            if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
                return Err("image probe did not return a PNG".to_string());
            }
            return Ok(());
        }
        if let Some("failed" | "cancelled" | "canceled") =
            payload.get("status").and_then(Value::as_str)
        {
            let message = payload
                .pointer("/error/message")
                .and_then(Value::as_str)
                .unwrap_or("image probe job failed");
            return Err(message.to_string());
        }
        if Instant::now() >= deadline {
            return Err("image probe did not complete within 120 seconds".to_string());
        }
        let poll_url = match payload.get("poll_url").and_then(Value::as_str) {
            Some(path) if path.starts_with("http") => path.to_string(),
            Some(path) => format!("{origin}{path}"),
            None => payload
                .get("id")
                .and_then(Value::as_str)
                .map(|id| format!("{origin}/sdcpp/v1/jobs/{id}"))
                .ok_or_else(|| "image probe job has no id or poll URL".to_string())?,
        };
        tokio::time::sleep(Duration::from_millis(500)).await;
        let response = client
            .get(poll_url)
            .send()
            .await
            .map_err(|error| format!("image probe poll failed: {error}"))?;
        let status = response.status();
        payload = response
            .json()
            .await
            .map_err(|_| format!("image probe poll returned non-JSON ({status})"))?;
        if !status.is_success() {
            return Err(format!("image probe poll returned {status}"));
        }
    }
}

fn scheduler_data_root() -> Result<PathBuf, String> {
    SCHEDULER_DATA_ROOT
        .get()
        .cloned()
        .ok_or_else(|| "Local model scheduler storage is not configured".to_string())
}

fn scheduler_client() -> Client {
    Client::builder()
        .connect_timeout(Duration::from_secs(2))
        .timeout(Duration::from_secs(15))
        .user_agent("KnowMotion-AI-Studio/0.1")
        .build()
        .unwrap_or_else(|_| Client::new())
}

fn normalize_origin(value: &str) -> String {
    let Ok(mut url) = Url::parse(value.trim()) else {
        return String::new();
    };
    if url.scheme() != "http" {
        return String::new();
    }
    url.set_path("");
    url.set_query(None);
    url.set_fragment(None);
    url.to_string().trim_end_matches('/').to_string()
}

fn endpoint_port(origin: &str) -> Result<u16, String> {
    Url::parse(origin)
        .map_err(|error| format!("Invalid local runtime URL: {error}"))?
        .port_or_known_default()
        .ok_or_else(|| "Local runtime URL must declare a port".to_string())
}

fn runtime_key(workload: Workload, base_url: &str) -> String {
    format!("{}:{}", workload.label(), normalize_origin(base_url))
}

fn mark_runtime_loaded(scheduler: &Arc<LocalModelScheduler>, key: &str, managed: bool) {
    if let Ok(mut state) = scheduler.state.lock() {
        if let Some(runtime) = state.runtimes.get_mut(key) {
            runtime.model_loaded = true;
            runtime.managed_process |= managed;
            runtime.last_used = Instant::now();
        }
    }
}

fn mark_runtime_smoke_tested(scheduler: &Arc<LocalModelScheduler>, key: &str) {
    if let Ok(mut state) = scheduler.state.lock() {
        if let Some(runtime) = state.runtimes.get_mut(key) {
            runtime.gpu_smoke_tested = true;
        }
    }
}

fn stop_managed_process(scheduler: &Arc<LocalModelScheduler>, key: &str) {
    if let Ok(mut processes) = scheduler.processes.lock() {
        processes.remove(key);
    }
    if let Ok(mut state) = scheduler.state.lock() {
        if let Some(runtime) = state.runtimes.get_mut(key) {
            runtime.model_loaded = false;
            runtime.managed_process = false;
        }
    }
    thread::sleep(Duration::from_millis(150));
}

fn managed_exit_status(scheduler: &Arc<LocalModelScheduler>, key: &str) -> Option<String> {
    scheduler
        .processes
        .lock()
        .ok()
        .and_then(|mut processes| processes.get_mut(key).and_then(ManagedProcess::exit_status))
}

fn managed_log_tail(scheduler: &Arc<LocalModelScheduler>, key: &str) -> String {
    scheduler
        .processes
        .lock()
        .ok()
        .and_then(|processes| processes.get(key).map(ManagedProcess::log_tail))
        .unwrap_or_default()
}

fn spawn_managed_process(
    runtime: Workload,
    executable: &Path,
    arguments: &[&str],
    signature: String,
) -> Result<ManagedProcess, String> {
    let log = Arc::new(Mutex::new(String::new()));
    let mut command = Command::new(executable);
    command
        .args(arguments)
        .current_dir(executable.parent().unwrap_or_else(|| Path::new(".")))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("GGML_LOG_COLORS", "0");
    hide_console_window(&mut command);
    let mut child = command.spawn().map_err(|error| {
        format!(
            "Unable to start {} server {}: {error}",
            runtime.display_label(),
            executable.display()
        )
    })?;
    let job_object = match ProcessJobObject::attach(&child) {
        Ok(job_object) => job_object,
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
    };
    drain_process_output(child.stdout.take(), Arc::clone(&log));
    drain_process_output(child.stderr.take(), Arc::clone(&log));
    Ok(ManagedProcess {
        signature,
        child,
        job_object,
        log,
    })
}

fn drain_process_output<R>(reader: Option<R>, log: Arc<Mutex<String>>)
where
    R: Read + Send + 'static,
{
    let Some(reader) = reader else {
        return;
    };
    thread::spawn(move || {
        for line in BufReader::new(reader).lines().map_while(Result::ok) {
            let Ok(mut log) = log.lock() else {
                return;
            };
            log.push_str(&line);
            log.push('\n');
            if log.len() > MAX_RUNTIME_LOG_BYTES {
                let mut split = log.len() - MAX_RUNTIME_LOG_BYTES;
                while split < log.len() && !log.is_char_boundary(split) {
                    split += 1;
                }
                log.drain(..split);
            }
        }
    });
}

fn infer_audio_family(model: &str, capability: &str) -> String {
    let normalized = model.trim().to_ascii_lowercase().replace('-', "_");
    if normalized.starts_with("qwen3_tts") {
        return "qwen3_tts".to_string();
    }
    if normalized.starts_with("qwen3_asr") {
        return "qwen3_asr".to_string();
    }
    if normalized.starts_with("qwen3_forced_aligner") {
        return "qwen3_forced_aligner".to_string();
    }
    if capability.eq_ignore_ascii_case("ASR") && normalized == "asr" {
        return "qwen3_asr".to_string();
    }
    if capability.eq_ignore_ascii_case("TTS") && normalized == "tts" {
        return "qwen3_tts".to_string();
    }
    normalized
}

fn audio_backend(preferred: Option<&str>) -> String {
    if preferred.is_some_and(|value| value.eq_ignore_ascii_case("cpu")) {
        return "cpu".to_string();
    }
    env::var("KNOWMOTION_AUDIO_BACKEND")
        .ok()
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| {
            crate::local_runtime::installed_acceleration("audio.cpp")
                .unwrap_or_else(|| "cuda".to_string())
        })
}

async fn audio_has_model(origin: &str, model: &str) -> bool {
    let Some(payload) = probe_json(&format!("{origin}/v1/models")).await else {
        return false;
    };
    json_contains_id(&payload, model)
}

fn json_contains_id(value: &Value, id: &str) -> bool {
    match value {
        Value::Array(items) => items.iter().any(|item| json_contains_id(item, id)),
        Value::Object(object) => {
            let direct_id = object
                .get("id")
                .or_else(|| object.get("model"))
                .and_then(Value::as_str);
            direct_id == Some(id) || object.values().any(|item| json_contains_id(item, id))
        }
        _ => false,
    }
}

async fn probe_json(url: &str) -> Option<Value> {
    let response = scheduler_client().get(url).send().await.ok()?;
    if !response.status().is_success() {
        return None;
    }
    response.json().await.ok()
}

fn nvidia_free_vram_mib() -> Option<u64> {
    let mut command = Command::new("nvidia-smi");
    command
        .args(["--query-gpu=memory.free", "--format=csv,noheader,nounits"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    hide_console_window(&mut command);
    let output = command.output().ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| line.trim().parse::<u64>().ok())
        .min()
}

#[cfg(windows)]
fn hide_console_window(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn hide_console_window(_command: &mut Command) {}

pub fn start_idle_reaper() {
    let interval = Duration::from_secs(env_u64("KNOWMOTION_IDLE_CHECK_SECONDS", 10).clamp(2, 300));
    let scheduler = scheduler();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(interval).await;
            scheduler.unload_idle_models().await;
        }
    });
}

pub async fn unload_all_models() -> Result<LocalModelSchedulerStatus, String> {
    let scheduler = scheduler();
    let _gate = scheduler.gate.clone().lock_owned().await;
    tokio::task::spawn_blocking(crate::agent::shutdown_llama_runtime)
        .await
        .map_err(|error| format!("Unable to stop llama.cpp: {error}"))?;
    let (audio, diffusion) = {
        let state = scheduler
            .state
            .lock()
            .map_err(|_| "Local model scheduler state is unavailable".to_string())?;
        (
            state.audio.keys().cloned().collect::<Vec<_>>(),
            state.diffusion.keys().cloned().collect::<Vec<_>>(),
        )
    };
    let client = scheduler_client();
    for url in audio {
        let _ = client
            .post(format!("{url}/v1/tasks/unload_all_models"))
            .send()
            .await;
    }
    for url in diffusion {
        let _ = client
            .post(format!("{url}/sdcpp/v1/models/unload"))
            .send()
            .await;
    }
    if let Ok(mut state) = scheduler.state.lock() {
        for runtime in state.runtimes.values_mut() {
            runtime.model_loaded = false;
        }
        state.active = None;
    }
    logging::log_event(
        LogLevel::Info,
        "local.models.unload",
        "All local models unloaded",
        None,
    );
    scheduler.status()
}

pub fn shutdown() {
    let scheduler = scheduler();
    let _ = scheduler.gate.try_lock();
    let processes = scheduler.processes.lock();
    if let Ok(mut processes) = processes {
        for process in processes.values_mut() {
            process.stop();
        }
        processes.clear();
    }
    if let Ok(mut state) = scheduler.state.lock() {
        state.active = None;
    };
}

#[tauri::command]
pub async fn local_model_scheduler_status() -> Result<LocalModelSchedulerStatus, String> {
    let scheduler = scheduler();
    let free = tokio::task::spawn_blocking(nvidia_free_vram_mib)
        .await
        .ok()
        .flatten();
    if let Some(free) = free {
        if let Ok(mut state) = scheduler.state.lock() {
            state.free_vram_mib = Some(free);
        }
    }
    scheduler.status()
}

#[tauri::command]
pub async fn unload_local_models() -> Result<LocalModelSchedulerStatus, String> {
    unload_all_models().await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gpu_smoke_wav_is_valid_for_asr_probe() {
        let wav = silent_wav();
        assert!(wav.starts_with(b"RIFF"));
        assert_eq!(wav.get(8..12), Some(b"WAVE".as_slice()));
        let reader = hound::WavReader::new(std::io::Cursor::new(wav)).expect("valid smoke WAV");
        assert_eq!(reader.spec().sample_rate, 16_000);
        assert_eq!(reader.duration(), 4_000);
    }

    #[test]
    fn accepts_only_plain_loopback_http_endpoints() {
        assert!(is_loopback_base_url("http://127.0.0.1:8080"));
        assert!(is_loopback_base_url("http://localhost:1234/v1"));
        assert!(is_loopback_base_url("http://[::1]:1234"));
        assert!(!is_loopback_base_url("https://127.0.0.1:8080"));
        assert!(!is_loopback_base_url("http://192.168.1.20:8080"));
        assert!(!is_loopback_base_url("http://user:secret@127.0.0.1:8080"));
    }

    #[test]
    fn normalizes_local_origin() {
        assert_eq!(
            normalize_origin("http://127.0.0.1:8080/v1/"),
            "http://127.0.0.1:8080"
        );
        assert_eq!(
            normalize_origin("http://[::1]:1234/base?q=1"),
            "http://[::1]:1234"
        );
    }

    #[test]
    fn infers_audio_cpp_runtime_families() {
        assert_eq!(infer_audio_family("qwen3-tts", "TTS"), "qwen3_tts");
        assert_eq!(
            infer_audio_family("qwen3_tts_1_7b_customvoice_q8_0", "TTS"),
            "qwen3_tts"
        );
        assert_eq!(
            infer_audio_family("qwen3-asr-1.7b-q8_0", "ASR"),
            "qwen3_asr"
        );
    }

    #[test]
    fn discovers_stable_diffusion_components_from_model_root() {
        let directory = tempfile::tempdir().expect("temp directory");
        let diffusion = directory.path().join("diffusion_models");
        let encoders = directory.path().join("text_encoders");
        let vae = directory.path().join("vae");
        fs::create_dir_all(&diffusion).expect("diffusion directory");
        fs::create_dir_all(&encoders).expect("encoder directory");
        fs::create_dir_all(&vae).expect("vae directory");
        fs::write(diffusion.join("qwen-image.gguf"), b"model").expect("diffusion file");
        fs::write(encoders.join("qwen3vl.gguf"), b"encoder").expect("encoder file");
        fs::write(vae.join("qwen.vae.safetensors"), b"vae").expect("vae file");

        assert_eq!(
            discover_model_component(directory.path(), ModelRole::Diffusion)
                .expect("diffusion component"),
            diffusion.join("qwen-image.gguf")
        );
        assert_eq!(
            discover_model_component(directory.path(), ModelRole::TextEncoder)
                .expect("text encoder component"),
            encoders.join("qwen3vl.gguf")
        );
        assert_eq!(
            discover_model_component(directory.path(), ModelRole::Vae).expect("vae component"),
            vae.join("qwen.vae.safetensors")
        );
    }

    #[test]
    fn reserve_stays_inside_safety_range() {
        assert!((MIN_VRAM_RESERVE_MIB..=MAX_VRAM_RESERVE_MIB).contains(&vram_reserve_mib()));
    }

    #[test]
    fn provider_idle_override_allows_immediate_unload() {
        let runtime = LocalRuntimeConfig {
            idle_unload_seconds: Some(0),
            ..LocalRuntimeConfig::default()
        };
        assert_eq!(idle_seconds(Some(&runtime), Workload::Audio), 0);
        assert_eq!(
            idle_seconds(None, Workload::Diffusion),
            DEFAULT_DIFFUSION_IDLE_SECONDS
        );
    }

    #[test]
    fn audio_model_status_accepts_nested_ids() {
        let payload = json!({
            "data": [
                {"id": "qwen3-tts"},
                {"model": "qwen3-asr"}
            ]
        });
        assert!(json_contains_id(&payload, "qwen3-tts"));
        assert!(json_contains_id(&payload, "qwen3-asr"));
        assert!(!json_contains_id(&payload, "missing"));
    }

    #[test]
    fn resident_llm_runtime_skips_the_vram_margin() {
        let mut runtimes = HashMap::new();
        runtimes.insert(
            "llm:acceptance-workflow-llm".to_string(),
            RuntimeRecord {
                runtime: Workload::Llm,
                base_url: "http://127.0.0.1:1".to_string(),
                model_loaded: true,
                managed_process: true,
                idle_seconds: 180,
                last_used: Instant::now(),
                gpu_smoke_tested: false,
            },
        );
        assert!(llm_runtime_is_resident(
            &runtimes,
            "acceptance-workflow-llm"
        ));

        runtimes
            .get_mut("llm:acceptance-workflow-llm")
            .expect("runtime record")
            .model_loaded = false;
        assert!(!llm_runtime_is_resident(
            &runtimes,
            "acceptance-workflow-llm"
        ));
        assert!(!llm_runtime_is_resident(&runtimes, "other-provider"));
    }
}
