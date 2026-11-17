use super::model::ProviderConfig;
use super::provider::{LlmProvider, LlmRequest, LlmResponse};
use crate::job_object::ProcessJobObject;
use crate::local_model_scheduler::GpuLease;
use async_trait::async_trait;
use reqwest::Client;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    env,
    io::{BufRead, BufReader, Read, Write},
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex, OnceLock},
    thread,
    time::{Duration, Instant},
};
use uuid::Uuid;

const DEFAULT_CONTEXT_SIZE: u32 = 8192;
const MIN_CONTEXT_SIZE: u32 = 512;
const MAX_CONTEXT_SIZE: u32 = 1_048_576;
const DEFAULT_START_TIMEOUT: Duration = Duration::from_secs(300);
const MAX_SERVER_LOG_BYTES: usize = 64 * 1024;

static SERVER_CACHE: OnceLock<Mutex<HashMap<PathBuf, Arc<LlamaServer>>>> = OnceLock::new();
static RUNTIME_RESOURCE_DIR: OnceLock<PathBuf> = OnceLock::new();

pub struct GgufLlmProvider {
    server: Arc<LlamaServer>,
    model_name: String,
    client: Client,
    _gpu_lease: Option<GpuLease>,
}

struct ServerActivity<'a>(&'a Mutex<Instant>);

impl Drop for ServerActivity<'_> {
    fn drop(&mut self) {
        if let Ok(mut last_used) = self.0.lock() {
            *last_used = Instant::now();
        }
    }
}

/// 本地推理超时下限。真正的上限按输出 token 数放大：27B IQ2 这类模型在 12 GB 卡上
/// 生成 6000 token 需要十几分钟，固定 600 s 会把正常的重活判成失败（实测 storyboard
/// 步骤就因为 600 s 超时而重试）。
const LOCAL_INFERENCE_TIMEOUT_FLOOR: Duration = Duration::from_secs(600);
const LOCAL_INFERENCE_BASE_OVERHEAD: Duration = Duration::from_secs(180);

fn local_inference_timeout(max_tokens: u32) -> Duration {
    // 按 6.7 tok/s 的下限估算输出时间，再叠加上下文处理与模型唤醒的固定开销。
    let generated = Duration::from_millis(max_tokens as u64 * 150);
    LOCAL_INFERENCE_TIMEOUT_FLOOR.max(LOCAL_INFERENCE_BASE_OVERHEAD + generated)
}

impl GgufLlmProvider {
    #[cfg(test)]
    pub fn load(config: &ProviderConfig) -> Result<Self, String> {
        Self::load_internal(config, None)
    }

    pub(crate) fn load_with_lease(
        config: &ProviderConfig,
        lease: GpuLease,
    ) -> Result<Self, String> {
        Self::load_internal(config, Some(lease))
    }

    fn load_internal(config: &ProviderConfig, lease: Option<GpuLease>) -> Result<Self, String> {
        let server = load_cached_server(config)?;
        let client = Client::builder()
            .timeout(LOCAL_INFERENCE_TIMEOUT_FLOOR)
            .connect_timeout(Duration::from_secs(2))
            .user_agent("KnowMotion-AI-Studio/0.1")
            .build()
            .map_err(|error| format!("Unable to create llama.cpp client: {error}"))?;
        Ok(Self {
            server,
            model_name: configured_model_name(config),
            client,
            _gpu_lease: lease,
        })
    }
}

#[async_trait]
impl LlmProvider for GgufLlmProvider {
    async fn complete(&self, request: LlmRequest) -> Result<LlmResponse, String> {
        let _activity = ServerActivity(&self.server.last_used);
        let requested_model = if request.model.trim().is_empty() {
            self.model_name.clone()
        } else {
            request.model.clone()
        };
        let user = if request.json_mode {
            format!(
                "{}\n\n严格输出要求：只返回一个完整、可解析的 JSON 对象，不要使用 Markdown 代码围栏。",
                request.user
            )
        } else {
            request.user.clone()
        };
        let mut payload = json!({
            "model": requested_model,
            "messages": [
                {"role": "system", "content": request.system},
                {"role": "user", "content": user}
            ],
            "temperature": request.temperature.max(0.0),
            "max_tokens": request.max_tokens.max(1),
            "stream": false
        });
        if request.json_mode {
            payload["response_format"] = json!({"type": "json_object"});
            // Qwen3 系列默认开 thinking，思维链会把 max_tokens 预算吃光，content 变成
            // 空字符串（实测 Storyboard 步骤连续两次 450 s 后返回空文本）。结构化 Agent
            // 要的是 JSON，不是推理过程，这里显式关掉；模板不支持 enable_thinking 时
            // llama.cpp 会忽略该变量，不影响其它模型。
            payload["chat_template_kwargs"] = json!({"enable_thinking": false});
        }

        let response = self
            .client
            .post(format!("{}/v1/chat/completions", self.server.base_url))
            .timeout(local_inference_timeout(request.max_tokens))
            .bearer_auth(&self.server.api_key)
            .json(&payload)
            .send()
            .await
            .map_err(|error| {
                if error.is_timeout() {
                    "llama.cpp inference timed out".to_string()
                } else {
                    format!(
                        "llama.cpp request failed: {}",
                        redact_error(&error.to_string())
                    )
                }
            })?;
        let status = response.status();
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            return Err(format!(
                "llama.cpp returned {status}: {}",
                sanitize_server_error(&body)
            ));
        }
        let body: Value = response
            .json()
            .await
            .map_err(|error| format!("Invalid llama.cpp response: {error}"))?;
        parse_completion_response(&requested_model, &body)
    }

    fn backend_label(&self) -> Option<&str> {
        Some(&self.server.backend_label)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BackendPreference {
    Auto,
    Gpu,
    Cpu,
}

impl BackendPreference {
    fn from_config(value: Option<&str>) -> Result<Self, String> {
        match value.unwrap_or("auto").trim().to_ascii_lowercase().as_str() {
            "" | "auto" => Ok(Self::Auto),
            "gpu" | "vulkan" | "dx12" => Ok(Self::Gpu),
            "cpu" => Ok(Self::Cpu),
            other => Err(format!("Unsupported GGUF inference backend: {other}")),
        }
    }
}

struct LlamaServer {
    child: Mutex<Child>,
    job_object: ProcessJobObject,
    base_url: String,
    api_key: String,
    backend_label: String,
    model_alias: String,
    context_size: u32,
    preference: BackendPreference,
    log: Arc<Mutex<String>>,
    last_used: Mutex<Instant>,
}

#[derive(Debug, Clone)]
struct GpuDevice {
    backend: &'static str,
    name: String,
}

impl LlamaServer {
    fn stop(&self) {
        let _ = self.job_object.terminate();
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    fn exit_status(&self) -> Option<String> {
        let mut child = self.child.lock().ok()?;
        child
            .try_wait()
            .ok()
            .flatten()
            .map(|status| status.to_string())
    }

    fn log_tail(&self) -> String {
        self.log
            .lock()
            .map(|log| log.chars().rev().take(3000).collect::<String>())
            .map(|log| log.chars().rev().collect())
            .unwrap_or_default()
    }
}

impl Drop for LlamaServer {
    fn drop(&mut self) {
        self.stop();
    }
}

pub(crate) fn configure_runtime(resource_dir: PathBuf) {
    let _ = RUNTIME_RESOURCE_DIR.set(resource_dir);
}

pub(crate) fn shutdown_runtime() {
    let Some(cache) = SERVER_CACHE.get() else {
        return;
    };
    let servers = match cache.lock() {
        Ok(mut cache) => std::mem::take(&mut *cache),
        Err(_) => return,
    };
    for (_, server) in servers {
        server.stop();
    }
}

pub(crate) fn unload_idle(max_idle: Duration) -> usize {
    let Some(cache) = SERVER_CACHE.get() else {
        return 0;
    };
    let Ok(mut cache) = cache.lock() else {
        return 0;
    };
    let stale = cache
        .iter()
        .filter_map(|(path, server)| {
            let idle = server
                .last_used
                .lock()
                .map(|last_used| last_used.elapsed() >= max_idle)
                .unwrap_or(false);
            (idle || server.exit_status().is_some()).then(|| path.clone())
        })
        .collect::<Vec<_>>();
    let count = stale.len();
    for path in stale {
        if let Some(server) = cache.remove(&path) {
            server.stop();
        }
    }
    count
}

fn load_cached_server(config: &ProviderConfig) -> Result<Arc<LlamaServer>, String> {
    let model_path = validate_model_path(&config.base_url)?;
    let context_size = config
        .context_size
        .unwrap_or(DEFAULT_CONTEXT_SIZE)
        .clamp(MIN_CONTEXT_SIZE, MAX_CONTEXT_SIZE);
    let preference = BackendPreference::from_config(config.inference_backend.as_deref())?;
    let model_alias = configured_model_name(config);
    let cache = SERVER_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let mut cache = cache
        .lock()
        .map_err(|_| "llama.cpp server cache is unavailable".to_string())?;

    if let Some(cached) = cache.get(&model_path) {
        if cached.context_size == context_size
            && cached.preference == preference
            && cached.model_alias == model_alias
        {
            return Ok(Arc::clone(cached));
        }
    }
    if let Some(stale) = cache.remove(&model_path) {
        stale.stop();
    }

    let executable = find_server_executable()?;
    let gpu_devices = match preference {
        BackendPreference::Cpu => Vec::new(),
        BackendPreference::Gpu | BackendPreference::Auto => list_gpu_devices(&executable),
    };
    if preference == BackendPreference::Gpu && gpu_devices.is_empty() {
        return Err(
            "GPU inference was requested, but llama.cpp detected no compatible CUDA or Vulkan GPU"
                .to_string(),
        );
    }

    let use_gpu = preference != BackendPreference::Cpu && !gpu_devices.is_empty();
    let server = match start_server(
        &executable,
        &model_path,
        &model_alias,
        context_size,
        preference,
        use_gpu,
        gpu_devices.first(),
    ) {
        Ok(server) => server,
        Err(gpu_error) if preference == BackendPreference::Auto && use_gpu => start_server(
            &executable,
            &model_path,
            &model_alias,
            context_size,
            preference,
            false,
            None,
        )
        .map_err(|cpu_error| {
            format!("Unable to start llama.cpp with GPU ({gpu_error}) or CPU ({cpu_error})")
        })?,
        Err(error) => return Err(error),
    };
    let server = Arc::new(server);
    cache.insert(model_path, Arc::clone(&server));
    Ok(server)
}

#[allow(clippy::too_many_arguments)]
fn start_server(
    executable: &Path,
    model_path: &Path,
    model_alias: &str,
    context_size: u32,
    preference: BackendPreference,
    use_gpu: bool,
    gpu_device: Option<&GpuDevice>,
) -> Result<LlamaServer, String> {
    let port = reserve_loopback_port()?;
    let api_key = Uuid::new_v4().to_string();
    let log = Arc::new(Mutex::new(String::new()));
    let mut command = Command::new(executable);
    command
        .arg("--model")
        .arg(model_path)
        .arg("--alias")
        .arg(model_alias)
        .arg("--ctx-size")
        .arg(context_size.to_string())
        .arg("--host")
        .arg("127.0.0.1")
        .arg("--port")
        .arg(port.to_string())
        .arg("--jinja")
        .arg("--no-webui")
        .current_dir(executable.parent().unwrap_or_else(|| Path::new(".")))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("LLAMA_LOG_COLORS", "0")
        .env("LLAMA_API_KEY", &api_key);
    if use_gpu {
        command.arg("--n-gpu-layers").arg("auto");
    } else {
        command
            .arg("--n-gpu-layers")
            .arg("0")
            .arg("--device")
            .arg("none");
    }
    hide_console_window(&mut command);

    let mut child = command.spawn().map_err(|error| {
        format!(
            "Unable to start llama.cpp server {}: {error}",
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
    let backend_label = if use_gpu {
        format!(
            "llama.cpp {} GPU · {}",
            gpu_device.map(|device| device.backend).unwrap_or("auto"),
            gpu_device
                .map(|device| device.name.as_str())
                .unwrap_or("auto-selected device")
        )
    } else if preference == BackendPreference::Auto {
        "llama.cpp CPU (no compatible Vulkan GPU)".to_string()
    } else {
        "llama.cpp CPU".to_string()
    };
    let server = LlamaServer {
        child: Mutex::new(child),
        job_object,
        base_url: format!("http://127.0.0.1:{port}"),
        api_key,
        backend_label,
        model_alias: model_alias.to_string(),
        context_size,
        preference,
        log,
        last_used: Mutex::new(Instant::now()),
    };
    wait_until_ready(&server, port).inspect_err(|_| {
        server.stop();
    })?;
    Ok(server)
}

fn reserve_loopback_port() -> Result<u16, String> {
    TcpListener::bind(("127.0.0.1", 0))
        .and_then(|listener| listener.local_addr())
        .map(|address| address.port())
        .map_err(|error| format!("Unable to reserve a llama.cpp loopback port: {error}"))
}

fn wait_until_ready(server: &LlamaServer, port: u16) -> Result<(), String> {
    let timeout = env::var("KNOWMOTION_LLAMA_START_TIMEOUT_SECONDS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .map(Duration::from_secs)
        .unwrap_or(DEFAULT_START_TIMEOUT);
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if health_response(port) {
            return Ok(());
        }
        if let Some(status) = server.exit_status() {
            let log = server.log_tail();
            return Err(format!(
                "llama.cpp server exited during model loading ({status}){}",
                if log.is_empty() {
                    String::new()
                } else {
                    format!(": {log}")
                }
            ));
        }
        thread::sleep(Duration::from_millis(150));
    }
    Err(format!(
        "llama.cpp model loading did not become ready within {} seconds",
        timeout.as_secs()
    ))
}

fn health_response(port: u16) -> bool {
    let address = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_millis(250)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(500)));
    if stream
        .write_all(b"GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        .is_err()
    {
        return false;
    }
    let mut response = [0_u8; 128];
    let read = stream.read(&mut response).unwrap_or(0);
    String::from_utf8_lossy(&response[..read])
        .lines()
        .next()
        .is_some_and(|status| status.contains(" 200 "))
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
            if log.len() > MAX_SERVER_LOG_BYTES {
                let mut split = log.len() - MAX_SERVER_LOG_BYTES;
                while split < log.len() && !log.is_char_boundary(split) {
                    split += 1;
                }
                log.drain(..split);
            }
        }
    });
}

fn find_server_executable() -> Result<PathBuf, String> {
    if let Some(configured) = env::var_os("KNOWMOTION_LLAMA_SERVER") {
        let path = PathBuf::from(configured);
        if path.is_file() {
            return path
                .canonicalize()
                .map_err(|error| format!("Unable to resolve llama.cpp server: {error}"));
        }
        return Err(format!(
            "KNOWMOTION_LLAMA_SERVER does not point to a file: {}",
            path.display()
        ));
    }
    if let Some(installed) = crate::local_runtime::installed_executable("llama.cpp") {
        return installed
            .canonicalize()
            .map_err(|error| format!("Unable to resolve llama.cpp server: {error}"));
    }

    let mut candidates = Vec::new();
    if let Some(resource_dir) = RUNTIME_RESOURCE_DIR.get() {
        candidates.push(resource_dir.join("resources/llama/llama-server.exe"));
        candidates.push(resource_dir.join("llama/llama-server.exe"));
    }
    candidates.push(Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/llama/llama-server.exe"));
    if let Ok(executable) = env::current_exe() {
        if let Some(directory) = executable.parent() {
            candidates.push(directory.join("resources/llama/llama-server.exe"));
            candidates.push(directory.join("llama/llama-server.exe"));
        }
    }
    for candidate in candidates {
        if candidate.is_file() {
            return candidate
                .canonicalize()
                .map_err(|error| format!("Unable to resolve llama.cpp server: {error}"));
        }
    }
    Err(
        "llama.cpp runtime is not installed. Select a local GGUF model in Models to download it."
            .to_string(),
    )
}

fn list_gpu_devices(executable: &Path) -> Vec<GpuDevice> {
    let mut command = Command::new(executable);
    command
        .arg("--list-devices")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("LLAMA_LOG_COLORS", "0");
    hide_console_window(&mut command);
    let Ok(output) = command.output() else {
        return Vec::new();
    };
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    stdout
        .lines()
        .chain(stderr.lines())
        .filter_map(|line| {
            let (device, name) = line.trim().split_once(':')?;
            let device = device.trim().to_ascii_lowercase();
            let backend = if device.starts_with("cuda") {
                "CUDA"
            } else if device.starts_with("vulkan") {
                "Vulkan"
            } else {
                return None;
            };
            (!name.trim().is_empty()).then(|| GpuDevice {
                backend,
                name: name.trim().to_string(),
            })
        })
        .collect()
}

fn configured_model_name(config: &ProviderConfig) -> String {
    let configured = config.model.trim();
    if !configured.is_empty() {
        return configured.replace(',', " ").trim().to_string();
    }
    Path::new(config.base_url.trim().trim_matches('"'))
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("local-gguf")
        .to_string()
}

fn validate_model_path(value: &str) -> Result<PathBuf, String> {
    let trimmed = value.trim().trim_matches('"');
    if trimmed.is_empty() {
        return Err("GGUF model file path is empty".to_string());
    }
    let path = Path::new(trimmed);
    if !path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("gguf"))
    {
        return Err("Local model must use the .gguf extension".to_string());
    }
    if !path.is_file() {
        return Err(format!(
            "GGUF model file does not exist: {}",
            path.display()
        ));
    }
    let metadata = path
        .metadata()
        .map_err(|error| format!("Unable to inspect GGUF model file: {error}"))?;
    if metadata.len() == 0 {
        return Err("GGUF model file is empty".to_string());
    }
    path.canonicalize()
        .map_err(|error| format!("Unable to resolve GGUF model path: {error}"))
}

fn parse_completion_response(requested_model: &str, body: &Value) -> Result<LlmResponse, String> {
    let text = body
        .pointer("/choices/0/message/content")
        .and_then(Value::as_str)
        .ok_or_else(|| "llama.cpp response has no message content".to_string())?;
    if text.trim().is_empty() {
        let finish_reason = body
            .pointer("/choices/0/finish_reason")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        let completion_tokens = body
            .pointer("/usage/completion_tokens")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let reasoning_chars = body
            .pointer("/choices/0/message/reasoning_content")
            .and_then(Value::as_str)
            .map(str::len)
            .unwrap_or(0);
        return Err(format!(
            "llama.cpp returned no text (finish_reason={finish_reason}, completion_tokens={completion_tokens}, reasoning_chars={reasoning_chars})"
        ));
    }
    Ok(LlmResponse {
        text: text.to_string(),
        model: body
            .get("model")
            .and_then(Value::as_str)
            .unwrap_or(requested_model)
            .to_string(),
        input_tokens: body.pointer("/usage/prompt_tokens").and_then(Value::as_u64),
        output_tokens: body
            .pointer("/usage/completion_tokens")
            .and_then(Value::as_u64),
    })
}

fn sanitize_server_error(body: &str) -> String {
    let message = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|value| {
            value
                .pointer("/error/message")
                .or_else(|| value.get("message"))
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_else(|| "llama.cpp request error".to_string());
    redact_error(&message).chars().take(500).collect()
}

fn redact_error(message: &str) -> String {
    message
        .split_whitespace()
        .map(|token| {
            if token.contains("api_key=") || token.contains("Authorization:") {
                "[redacted]".to_string()
            } else {
                token.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(windows)]
fn hide_console_window(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn hide_console_window(_command: &mut Command) {}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn parses_backend_preferences() {
        assert_eq!(
            BackendPreference::from_config(None).expect("default preference"),
            BackendPreference::Auto
        );
        assert_eq!(
            BackendPreference::from_config(Some("gpu")).expect("GPU preference"),
            BackendPreference::Gpu
        );
        assert_eq!(
            BackendPreference::from_config(Some("dx12")).expect("legacy GPU preference"),
            BackendPreference::Gpu
        );
        assert_eq!(
            BackendPreference::from_config(Some("cpu")).expect("CPU preference"),
            BackendPreference::Cpu
        );
        assert!(BackendPreference::from_config(Some("opencl")).is_err());
    }

    #[test]
    fn rejects_non_gguf_model_paths() {
        assert!(validate_model_path("C:\\models\\model.bin")
            .unwrap_err()
            .contains(".gguf"));
    }

    #[test]
    fn rejects_empty_model_files() {
        let directory = tempfile::tempdir().expect("temp directory");
        let path = directory.path().join("empty.gguf");
        std::fs::File::create(&path)
            .and_then(|mut file| file.write_all(&[]))
            .expect("create empty model");
        assert!(validate_model_path(path.to_str().expect("utf-8 path"))
            .unwrap_err()
            .contains("empty"));
    }

    #[test]
    fn accepts_existing_gguf_files() {
        let directory = tempfile::tempdir().expect("temp directory");
        let path = directory.path().join("model.gguf");
        std::fs::write(&path, b"GGUF").expect("create model placeholder");
        assert_eq!(
            validate_model_path(path.to_str().expect("utf-8 path")).expect("valid path"),
            path.canonicalize().expect("canonical path")
        );
    }

    #[test]
    fn parses_llama_cpp_openai_response() {
        let response = parse_completion_response(
            "qwen-local",
            &json!({
                "model": "qwen-local",
                "choices": [{"message": {"content": "hello"}}],
                "usage": {"prompt_tokens": 9, "completion_tokens": 2}
            }),
        )
        .expect("parse response");
        assert_eq!(response.text, "hello");
        assert_eq!(response.input_tokens, Some(9));
        assert_eq!(response.output_tokens, Some(2));
    }

    #[test]
    #[ignore = "requires KNOWMOTION_GGUF_TEST_MODEL and the prepared llama.cpp runtime"]
    fn generates_with_the_packaged_llama_cpp_server() {
        let model_path = std::env::var("KNOWMOTION_GGUF_TEST_MODEL").expect("GGUF test model path");
        let provider = GgufLlmProvider::load(&ProviderConfig {
            id: "gguf-llama-cpp-test".to_string(),
            name: "GGUF llama.cpp test".to_string(),
            protocol: "GGUF".to_string(),
            base_url: model_path,
            model: "knowmotion-test".to_string(),
            context_size: Some(512),
            inference_backend: Some("cpu".to_string()),
            runtime: None,
            enabled: true,
            capabilities: vec!["LLM".to_string()],
        })
        .expect("load llama.cpp server");
        assert_eq!(provider.backend_label(), Some("llama.cpp CPU"));
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("tokio runtime");
        let response = runtime
            .block_on(provider.complete(LlmRequest {
                model: "knowmotion-test".to_string(),
                system: "Answer concisely.".to_string(),
                user: "Reply with hello.".to_string(),
                temperature: 0.0,
                max_tokens: 16,
                json_mode: false,
            }))
            .expect("generate with llama.cpp");
        assert!(!response.text.trim().is_empty());
        shutdown_runtime();
    }

    #[test]
    #[ignore = "requires KNOWMOTION_GGUF_TEST_MODEL, the prepared llama.cpp runtime, and a Vulkan GPU"]
    fn selects_a_vulkan_gpu_when_available() {
        let model_path = std::env::var("KNOWMOTION_GGUF_TEST_MODEL").expect("GGUF test model path");
        let provider = GgufLlmProvider::load(&ProviderConfig {
            id: "gguf-vulkan-test".to_string(),
            name: "GGUF Vulkan test".to_string(),
            protocol: "GGUF".to_string(),
            base_url: model_path,
            model: "knowmotion-test".to_string(),
            context_size: Some(512),
            inference_backend: Some("auto".to_string()),
            runtime: None,
            enabled: true,
            capabilities: vec!["LLM".to_string()],
        })
        .expect("load llama.cpp on auto backend");
        assert!(
            provider
                .backend_label()
                .is_some_and(|label| label.starts_with("llama.cpp Vulkan GPU")),
            "expected a Vulkan GPU backend, got {:?}",
            provider.backend_label()
        );
        shutdown_runtime();
    }

    #[test]
    fn inference_timeout_scales_with_output_tokens() {
        // 6000 token 的本地生成在多分钟内完成，固定 600 s 会把正常请求判成超时。
        assert_eq!(local_inference_timeout(16), LOCAL_INFERENCE_TIMEOUT_FLOOR);
        assert!(local_inference_timeout(6000) > LOCAL_INFERENCE_TIMEOUT_FLOOR);
        assert_eq!(local_inference_timeout(6000).as_secs(), 180 + 900);
        assert!(local_inference_timeout(8000) > local_inference_timeout(6000));
    }
}
