//! 真实本地模型服务端到端验收。
//!
//! 这套用例走应用真实的 Provider 与调度器代码路径：
//!
//! * LLM：`GGUF` Provider → `LocalModelScheduler` GPU 租约 → `llama-server` → `/v1/chat/completions`
//! * Embedding：`OpenAI Compatible` Provider → 回环 `/embeddings`
//! * TTS / ASR：`audio.cpp` Provider → 自动生成配置并启动 `audiocpp_server` → `/v1/audio/speech` 与 `/v1/audio/transcriptions/details`
//! * Image：`stable-diffusion.cpp` Provider → 自动发现三个模型组件并启动 `sd-server` → `/v1/images/generations`
//!
//! 用例默认被 `#[ignore]` 跳过，因为它需要真实模型文件、真实运行时二进制和
//! 一台能跑 Vulkan 的 GPU。执行方式：
//!
//! ```text
//! cd src-tauri
//! cargo test --lib real_service_acceptance -- --ignored --nocapture --test-threads=1
//! ```
//!
//! 可用环境变量：
//!
//! * `KNOWMOTION_ACCEPTANCE_MODELS`：模型根目录，默认仓库下 `models/`
//! * `KNOWMOTION_ACCEPTANCE_DATA_DIR`：应用数据目录，默认 `%APPDATA%/com.knowmotion.studio`
//! * `KNOWMOTION_ACCEPTANCE_OUT_DIR`：产物与报告目录，默认 `src-tauri/target/acceptance`
//! * `KNOWMOTION_ACCEPTANCE_IMAGE_SIZE`：图片验收尺寸，默认 `768x768`

use crate::{
    agent::{
        clear_provider_secret, resolve_provider, save_provider_secret, AgentModelRoute,
        AgentRuntime, LlmRequest, ProviderConfig, WorkflowEventSink, WorkflowStartRequest,
    },
    capabilities::{
        cosine_similarity, execute_inpaint, generate_images_for_provider, request_embeddings,
        synthesize_speech, transcribe_audio, wav_duration_ms, ImageProviderConfig,
    },
    local_model_scheduler::{self, LocalRuntimeConfig},
    local_runtime,
};
use serde_json::{json, Value};
use std::{
    env, fs,
    net::TcpListener,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Arc,
    time::{Duration, Instant},
};

const EMBEDDING_PROVIDER_ID: &str = "acceptance-embedding";

struct Harness {
    models: PathBuf,
    data_dir: PathBuf,
    out_dir: PathBuf,
    capabilities: Vec<Value>,
}

impl Harness {
    fn from_environment() -> Self {
        let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
        let project_root = manifest.parent().unwrap_or(manifest).to_path_buf();
        let models = env::var_os("KNOWMOTION_ACCEPTANCE_MODELS")
            .map(PathBuf::from)
            .unwrap_or_else(|| project_root.join("models"));
        let data_dir = env::var_os("KNOWMOTION_ACCEPTANCE_DATA_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                let appdata = env::var_os("APPDATA").unwrap_or_default();
                PathBuf::from(appdata).join("com.knowmotion.studio")
            });
        let out_dir = env::var_os("KNOWMOTION_ACCEPTANCE_OUT_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| manifest.join("target/acceptance"));
        fs::create_dir_all(&out_dir).expect("acceptance output directory");
        Self {
            models,
            data_dir,
            out_dir,
            capabilities: Vec::new(),
        }
    }

    fn model(&self, relative: &str) -> PathBuf {
        self.models.join(relative)
    }

    fn configure(&self) {
        local_runtime::configure(self.data_dir.join("runtimes"));
        local_model_scheduler::configure(self.data_dir.clone());
    }

    fn record(&mut self, value: Value) {
        let name = value
            .get("capability")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string();
        let ok = value.get("ok").and_then(Value::as_bool).unwrap_or(false);
        let detail = value
            .get("detail")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        if ok {
            println!("[acceptance] {name} PASS {detail}");
        } else {
            println!("[acceptance] {name} FAIL {detail}");
        }
        self.capabilities.push(value);
    }

    fn artifact_path(&self, name: &str) -> PathBuf {
        self.out_dir.join(name)
    }

    fn write_artifact(&self, name: &str, bytes: &[u8]) -> String {
        let path = self.artifact_path(name);
        fs::write(&path, bytes).expect("acceptance artifact");
        path.to_string_lossy().to_string()
    }

    fn report(&self, runtimes: Value, environment: Value) -> Value {
        let failed = self
            .capabilities
            .iter()
            .filter(|entry| entry.get("ok").and_then(Value::as_bool) != Some(true))
            .count();
        json!({
            "generatedAt": chrono::Utc::now().to_rfc3339(),
            "environment": environment,
            "runtimes": runtimes,
            "summary": {
                "total": self.capabilities.len(),
                "passed": self.capabilities.len() - failed,
                "failed": failed
            },
            "capabilities": self.capabilities
        })
    }
}

struct EmbeddingServer {
    child: Child,
    base_url: String,
    api_key: String,
    log_path: PathBuf,
}

impl EmbeddingServer {
    async fn start(executable: &Path, model: &Path, out_dir: &Path) -> Result<Self, String> {
        if !model.is_file() {
            return Err(format!("Embedding model is missing: {}", model.display()));
        }
        let port = free_loopback_port()?;
        let api_key = uuid::Uuid::new_v4().to_string();
        let log_path = out_dir.join("embedding-server.log");
        let log = fs::File::create(&log_path).map_err(|error| error.to_string())?;
        let mut command = Command::new(executable);
        command
            .arg("--model")
            .arg(model)
            .arg("--alias")
            .arg("embeddinggemma")
            .arg("--embeddings")
            .arg("--ctx-size")
            .arg("2048")
            .arg("--host")
            .arg("127.0.0.1")
            .arg("--port")
            .arg(port.to_string())
            .arg("--no-webui")
            .current_dir(executable.parent().unwrap_or(Path::new(".")))
            .env("LLAMA_LOG_COLORS", "0")
            .env("LLAMA_API_KEY", &api_key)
            .stdin(Stdio::null())
            .stdout(Stdio::from(log.try_clone().map_err(|e| e.to_string())?))
            .stderr(Stdio::from(log));
        hide_console(&mut command);
        let child = command
            .spawn()
            .map_err(|error| format!("Unable to start embedding llama-server: {error}"))?;
        let server = Self {
            child,
            base_url: format!("http://127.0.0.1:{port}"),
            api_key,
            log_path,
        };
        wait_for_http(
            &format!("{}/health", server.base_url),
            Duration::from_secs(180),
        )
        .await
        .map_err(|error| format!("{error}\n{}", server.log_tail()))?;
        Ok(server)
    }

    fn log_tail(&self) -> String {
        fs::read_to_string(&self.log_path)
            .map(|text| tail(&text, 2000))
            .unwrap_or_default()
    }
}

impl Drop for EmbeddingServer {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[test]
#[ignore = "requires real GGUF models, local runtimes and a Vulkan GPU"]
fn real_service_acceptance() {
    let mut harness = Harness::from_environment();
    harness.configure();
    let environment = environment_report();
    let runtimes = runtime_report(&harness);
    println!(
        "[acceptance] models={} data={} out={}",
        harness.models.display(),
        harness.data_dir.display(),
        harness.out_dir.display()
    );

    let only = env::var("KNOWMOTION_ACCEPTANCE_ONLY").ok().map(|value| {
        value
            .split(',')
            .map(|item| item.trim().to_ascii_uppercase())
            .filter(|item| !item.is_empty())
            .collect::<Vec<_>>()
    });
    let wants = |capability: &str| {
        only.as_ref()
            .map(|list| list.iter().any(|item| item == capability))
            .unwrap_or(true)
    };

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    runtime.block_on(async {
        if wants("LLM") {
            let outcome = run_llm(&harness).await;
            harness.record(outcome);
        }
        if wants("EMBEDDING") {
            let outcome = run_embedding(&harness).await;
            harness.record(outcome);
        }
        if wants("TTS") {
            let outcome = run_tts(&harness).await;
            harness.record(outcome);
        }
        if wants("ASR") {
            let outcome = run_asr(&harness).await;
            harness.record(outcome);
        }
        if wants("IMAGE") {
            let outcome = run_image(&harness).await;
            harness.record(outcome);
        }
    });

    let report = harness.report(runtimes, environment);
    let path = harness.artifact_path("acceptance-report.json");
    fs::write(
        &path,
        serde_json::to_vec_pretty(&report).expect("report json"),
    )
    .expect("write report");
    println!(
        "{}",
        serde_json::to_string_pretty(&report).unwrap_or_default()
    );
    println!("[acceptance] report written to {}", path.display());

    let failed = report
        .pointer("/summary/failed")
        .and_then(Value::as_u64)
        .unwrap_or(1);
    assert_eq!(
        failed, 0,
        "real service acceptance has failing capabilities"
    );
}

async fn run_llm(harness: &Harness) -> Value {
    let started = Instant::now();
    let model = harness.model("Qwen3.8-27B/Qwen3.8-27B-UD-IQ2_S.gguf");
    let config = ProviderConfig {
        id: "acceptance-llm".to_string(),
        name: "Qwen3.8-27B · Vulkan".to_string(),
        protocol: "GGUF".to_string(),
        base_url: model.to_string_lossy().to_string(),
        model: "Qwen3.8-27B-UD-IQ2_S".to_string(),
        context_size: Some(4096),
        inference_backend: Some("gpu".to_string()),
        runtime: None,
        enabled: true,
        capabilities: vec!["LLM".to_string()],
    };
    let result = async {
        if !model.is_file() {
            return Err(format!("LLM model is missing: {}", model.display()));
        }
        let provider = resolve_provider(&config, None).await?;
        let backend = "GGUF / llama.cpp".to_string();
        let response = provider
            .complete(LlmRequest {
                model: config.model.clone(),
                system: "你是知识动画的分镜策划。只输出 JSON。".to_string(),
                user: r#"为「天空为什么是蓝色的？」生成一个分镜对象，字段固定为 {"title": 字符串, "narration": 字符串, "keywords": 字符串数组}。旁白不超过 40 个汉字。"#
                    .to_string(),
                temperature: 0.2,
                max_tokens: 320,
                json_mode: true,
            })
            .await?;
        drop(provider);
        let parsed: Value = serde_json::from_str(response.text.trim()).map_err(|error| {
            format!(
                "LLM 输出不是合法 JSON ({error}): {}",
                tail(&response.text, 400)
            )
        })?;
        let narration = parsed
            .get("narration")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        if narration.trim().is_empty() {
            return Err("LLM 输出的 narration 为空".to_string());
        }
        let keywords = parsed
            .get("keywords")
            .and_then(Value::as_array)
            .map(|items| items.len())
            .unwrap_or(0);
        let artifact = harness.write_artifact("llm-storyboard.json", response.text.as_bytes());
        Ok(json!({
            "backend": backend,
            "model": response.model,
            "inputTokens": response.input_tokens,
            "outputTokens": response.output_tokens,
            "narration": narration,
            "keywords": keywords,
            "artifact": artifact
        }))
    }
    .await;
    // llama-server 由应用缓存持有；显式释放，避免占用后续 TTS/图片所需显存。
    crate::agent::shutdown_llama_runtime();
    match result {
        Ok(detail) => json!({
            "capability": "LLM",
            "model": "Qwen3.8-27B-UD-IQ2_S.gguf",
            "protocol": "GGUF / llama.cpp",
            "ok": true,
            "elapsedMs": started.elapsed().as_millis(),
            "detail": detail.get("narration").and_then(Value::as_str).unwrap_or_default(),
            "checks": detail
        }),
        Err(error) => json!({
            "capability": "LLM",
            "model": "Qwen3.8-27B-UD-IQ2_S.gguf",
            "protocol": "GGUF / llama.cpp",
            "ok": false,
            "elapsedMs": started.elapsed().as_millis(),
            "detail": error
        }),
    }
}

async fn run_embedding(harness: &Harness) -> Value {
    let started = Instant::now();
    let model = harness.model("embeddinggemma-2/embeddinggemma-2-Q8_0.gguf");
    let result: Result<Value, String> = async {
        let executable = local_runtime::installed_executable("llama.cpp")
            .ok_or_else(|| "llama.cpp runtime is not installed".to_string())?;
        let server = EmbeddingServer::start(&executable, &model, &harness.out_dir).await?;
        save_provider_secret(EMBEDDING_PROVIDER_ID, &server.api_key)?;
        let provider = ImageProviderConfig {
            id: EMBEDDING_PROVIDER_ID.to_string(),
            name: "EmbeddingGemma · Vulkan".to_string(),
            protocol: "OpenAI Compatible".to_string(),
            // 与应用其它 OpenAI Compatible 调用一致：base URL 需要包含版本前缀，
            // 否则 llama.cpp 会落到不兼容的 legacy `/embeddings` 形态。
            base_url: format!("{}/v1", server.base_url),
            model: "embeddinggemma".to_string(),
            context_size: None,
            inference_backend: Some("gpu".to_string()),
            runtime: None,
            enabled: true,
            capabilities: vec!["Embedding".to_string()],
        };
        let query = "太阳为什么在傍晚变红".to_string();
        let related =
            "傍晚的阳光要穿过更厚的大气层，蓝光被散射掉，只剩下红光进入眼睛。".to_string();
        let unrelated = "Excel 透视表可以按季度汇总各区域的销售额。".to_string();
        let vectors = request_embeddings(
            &provider,
            &[query.clone(), related.clone(), unrelated.clone()],
        )
        .await?;
        let dimensions = vectors.first().map(Vec::len).unwrap_or(0);
        if dimensions == 0 || vectors.iter().any(|vector| vector.len() != dimensions) {
            return Err("Embedding 维度不一致或为空".to_string());
        }
        let near = cosine_similarity(&vectors[0], &vectors[1]).unwrap_or(f64::NEG_INFINITY);
        let far = cosine_similarity(&vectors[0], &vectors[2]).unwrap_or(f64::INFINITY);
        if !matches!(
            near.partial_cmp(&(far + 0.02)),
            Some(std::cmp::Ordering::Greater)
        ) {
            return Err(format!(
                "Embedding 语义排序不符合预期：相关 {near:.4} 未明显高于无关 {far:.4}"
            ));
        }
        let artifact = harness.write_artifact(
            "embedding-vectors.json",
            serde_json::to_vec_pretty(&json!({
                "model": provider.model,
                "baseUrl": server.base_url,
                "dimensions": dimensions,
                "relatedScore": near,
                "unrelatedScore": far,
                "vectors": vectors
                    .iter()
                    .map(|vector| vector.iter().take(8).copied().collect::<Vec<_>>())
                    .collect::<Vec<_>>()
            }))
            .unwrap_or_default()
            .as_slice(),
        );
        clear_provider_secret(EMBEDDING_PROVIDER_ID).ok();
        Ok(json!({
            "dimensions": dimensions,
            "relatedScore": near,
            "unrelatedScore": far,
            "baseUrl": server.base_url,
            "artifact": artifact
        }))
    }
    .await;
    match result {
        Ok(detail) => json!({
            "capability": "Embedding",
            "model": "embeddinggemma-2-Q8_0.gguf",
            "protocol": "OpenAI Compatible / llama.cpp",
            "ok": true,
            "elapsedMs": started.elapsed().as_millis(),
            "detail": format!(
                "dim={} related={:.4} unrelated={:.4}",
                detail.get("dimensions").and_then(Value::as_u64).unwrap_or(0),
                detail.get("relatedScore").and_then(Value::as_f64).unwrap_or(0.0),
                detail.get("unrelatedScore").and_then(Value::as_f64).unwrap_or(0.0)
            ),
            "checks": detail
        }),
        Err(error) => json!({
            "capability": "Embedding",
            "model": "embeddinggemma-2-Q8_0.gguf",
            "protocol": "OpenAI Compatible / llama.cpp",
            "ok": false,
            "elapsedMs": started.elapsed().as_millis(),
            "detail": error
        }),
    }
}

const NARRATION: &str =
    "阳光穿过大气时，蓝光被空气分子散射到四面八方。于是我们抬头，看见整片天空都是蓝色的。";

fn audio_provider(
    harness: &Harness,
    model: &str,
    model_file: &str,
    capability: &str,
    family: &str,
) -> ImageProviderConfig {
    ImageProviderConfig {
        id: format!("acceptance-{}", capability.to_lowercase()),
        name: format!("Qwen3 {capability} · audio.cpp"),
        protocol: "audio.cpp".to_string(),
        base_url: "http://127.0.0.1:8091".to_string(),
        model: model.to_string(),
        context_size: None,
        inference_backend: Some("gpu".to_string()),
        runtime: Some(LocalRuntimeConfig {
            model_path: Some(harness.model(model_file).to_string_lossy().to_string()),
            model_directory: None,
            model_family: Some(family.to_string()),
            diffusion_model: None,
            text_encoder: None,
            llm_vision: None,
            vae: None,
            idle_unload_seconds: Some(600),
        }),
        enabled: true,
        capabilities: vec![capability.to_string()],
    }
}

async fn run_tts(harness: &Harness) -> Value {
    let started = Instant::now();
    let model_dir = harness.model("qwen3-tts");
    let provider = audio_provider(
        harness,
        "qwen3_tts",
        "qwen3-tts/qwen3-tts-12hz-1.7b-customvoice-q8_0.gguf",
        "TTS",
        "qwen3_tts",
    );
    let result: Result<Value, String> = async {
        if !model_dir.is_dir() {
            return Err(format!("TTS 模型目录缺失: {}", model_dir.display()));
        }
        let lease = local_model_scheduler::acquire_gpu(
            local_model_scheduler::Workload::Audio,
            &provider.id,
            &provider.base_url,
            provider.runtime.as_ref(),
            provider.inference_backend.as_deref(),
        )
        .await?;
        local_model_scheduler::ensure_audio(
            &provider.id,
            &provider.base_url,
            &provider.model,
            "TTS",
            provider.runtime.as_ref(),
            provider.inference_backend.as_deref(),
        )
        .await?;
        let bytes = synthesize_speech(&provider, None, NARRATION, "serena", 1.0).await?;
        drop(lease);
        let duration_ms = wav_duration_ms(&bytes)?;
        if duration_ms < 1500 {
            return Err(format!("TTS 音频过短: {duration_ms} ms"));
        }
        let artifact = harness.write_artifact("narration.wav", &bytes);
        Ok(json!({
            "durationMs": duration_ms,
            "bytes": bytes.len(),
            "voice": "serena",
            "baseUrl": provider.base_url,
            "artifact": artifact
        }))
    }
    .await;
    match result {
        Ok(detail) => json!({
            "capability": "TTS",
            "model": "qwen3-tts-12hz-1.7b-customvoice-q8_0.gguf",
            "protocol": "audio.cpp",
            "ok": true,
            "elapsedMs": started.elapsed().as_millis(),
            "detail": format!(
                "{} ms / {} bytes",
                detail.get("durationMs").and_then(Value::as_u64).unwrap_or(0),
                detail.get("bytes").and_then(Value::as_u64).unwrap_or(0)
            ),
            "checks": detail
        }),
        Err(error) => json!({
            "capability": "TTS",
            "model": "qwen3-tts-12hz-1.7b-customvoice-q8_0.gguf",
            "protocol": "audio.cpp",
            "ok": false,
            "elapsedMs": started.elapsed().as_millis(),
            "detail": error
        }),
    }
}

async fn run_asr(harness: &Harness) -> Value {
    let started = Instant::now();
    let provider = audio_provider(
        harness,
        "qwen3_asr",
        "qwen3-asr/qwen3-asr-1.7b-q8_0.gguf",
        "ASR",
        "qwen3_asr",
    );
    let result: Result<Value, String> = async {
        let wav_path = harness.artifact_path("narration.wav");
        let audio = fs::read(&wav_path)
            .map_err(|error| format!("TTS 产物不可用，无法做 TTS→ASR 闭环: {error}"))?;
        let lease = local_model_scheduler::acquire_gpu(
            local_model_scheduler::Workload::Audio,
            &provider.id,
            &provider.base_url,
            provider.runtime.as_ref(),
            provider.inference_backend.as_deref(),
        )
        .await?;
        local_model_scheduler::ensure_audio(
            &provider.id,
            &provider.base_url,
            &provider.model,
            "ASR",
            provider.runtime.as_ref(),
            provider.inference_backend.as_deref(),
        )
        .await?;
        let (text, cues) = transcribe_audio(&provider, None, "narration.wav", &audio).await?;
        drop(lease);
        if text.trim().is_empty() {
            return Err("ASR 返回文本为空".to_string());
        }
        let similarity = char_overlap(NARRATION, &text);
        if similarity < 0.4 {
            return Err(format!(
                "ASR 文本与旁白差异过大 (相似度 {similarity:.3})：{text}"
            ));
        }
        let artifact = harness.write_artifact(
            "asr-result.json",
            serde_json::to_vec_pretty(&json!({
                "text": text,
                "cues": cues,
                "expected": NARRATION,
                "charOverlap": similarity
            }))
            .unwrap_or_default()
            .as_slice(),
        );
        Ok(json!({
            "text": text,
            "cues": cues.len(),
            "charOverlap": similarity,
            "artifact": artifact
        }))
    }
    .await;
    match result {
        Ok(detail) => json!({
            "capability": "ASR",
            "model": "qwen3-asr-1.7b-q8_0.gguf",
            "protocol": "audio.cpp",
            "ok": true,
            "elapsedMs": started.elapsed().as_millis(),
            "detail": format!(
                "{} / cues={} / overlap={:.3}",
                detail.get("text").and_then(Value::as_str).unwrap_or_default(),
                detail.get("cues").and_then(Value::as_u64).unwrap_or(0),
                detail.get("charOverlap").and_then(Value::as_f64).unwrap_or(0.0)
            ),
            "checks": detail
        }),
        Err(error) => json!({
            "capability": "ASR",
            "model": "qwen3-asr-1.7b-q8_0.gguf",
            "protocol": "audio.cpp",
            "ok": false,
            "elapsedMs": started.elapsed().as_millis(),
            "detail": error
        }),
    }
}

async fn run_image(harness: &Harness) -> Value {
    let started = Instant::now();
    let root = harness.model("qwen-image-2.1");
    let size =
        env::var("KNOWMOTION_ACCEPTANCE_IMAGE_SIZE").unwrap_or_else(|_| "768x768".to_string());
    let provider = ImageProviderConfig {
        id: "acceptance-image".to_string(),
        name: "Qwen Image 2.1 · stable-diffusion.cpp".to_string(),
        protocol: "stable-diffusion.cpp".to_string(),
        base_url: "http://127.0.0.1:1234".to_string(),
        model: "sd-cpp-local".to_string(),
        context_size: None,
        inference_backend: Some("gpu".to_string()),
        runtime: Some(LocalRuntimeConfig {
            model_path: None,
            model_directory: Some(root.to_string_lossy().to_string()),
            model_family: None,
            diffusion_model: Some(
                root.join("qwen-image-2.1-turbo-Q4_K_M.gguf")
                    .to_string_lossy()
                    .to_string(),
            ),
            text_encoder: Some(
                root.join("Qwen3-VL-8B-Instruct-Q4_K_M.gguf")
                    .to_string_lossy()
                    .to_string(),
            ),
            llm_vision: None,
            vae: Some(
                root.join("qwen_image_2.1_vae_bf16.safetensors")
                    .to_string_lossy()
                    .to_string(),
            ),
            idle_unload_seconds: Some(600),
        }),
        enabled: true,
        capabilities: vec!["Image".to_string()],
    };
    let prompt =
        "知识动画画面：傍晚的天空由蓝转红，太阳贴近地平线，海面反射暖色光，扁平插画风格，干净构图";
    let result: Result<Value, String> = async {
        let (images, mode) = generate_images_for_provider(&provider, prompt, &size, 1).await?;
        let image = images
            .into_iter()
            .next()
            .ok_or_else(|| "图片服务未返回任何图像".to_string())?;
        let (width, height) = png_dimensions(&image)?;
        let artifact = harness.write_artifact("image-scene.png", &image);
        Ok(json!({
            "mode": mode,
            "width": width,
            "height": height,
            "bytes": image.len(),
            "sha256": sha256_hex(&image),
            "requestedSize": size,
            "artifact": artifact
        }))
    }
    .await;
    match result {
        Ok(detail) => json!({
            "capability": "Image",
            "model": "qwen-image-2.1-turbo-Q4_K_M.gguf + Qwen3-VL-8B + VAE",
            "protocol": "stable-diffusion.cpp",
            "ok": true,
            "elapsedMs": started.elapsed().as_millis(),
            "detail": format!(
                "{}x{} / {} bytes",
                detail.get("width").and_then(Value::as_u64).unwrap_or(0),
                detail.get("height").and_then(Value::as_u64).unwrap_or(0),
                detail.get("bytes").and_then(Value::as_u64).unwrap_or(0)
            ),
            "checks": detail
        }),
        Err(error) => json!({
            "capability": "Image",
            "model": "qwen-image-2.1-turbo-Q4_K_M.gguf + Qwen3-VL-8B + VAE",
            "protocol": "stable-diffusion.cpp",
            "ok": false,
            "elapsedMs": started.elapsed().as_millis(),
            "detail": error
        }),
    }
}

// ---------------------------------------------------------------------------
// P0：局部重绘两条图片通道的真实服务验收
// ---------------------------------------------------------------------------

/// 合成一张有明确纹理的源图，方便判断“哪块像素被重画了”。
fn synth_source_png(size: u32) -> Vec<u8> {
    let mut pixels = Vec::with_capacity((size * size * 3) as usize);
    for y in 0..size {
        for x in 0..size {
            let checker = ((x / 16) + (y / 16)) % 2 == 0;
            let base = if checker { 200_u8 } else { 40_u8 };
            // 左右两半色调不同，重绘时更容易观察到区域归属。
            let (r, g) = if x < size / 2 {
                (base, base / 2)
            } else {
                (base / 3, base)
            };
            pixels.extend_from_slice(&[r, g, 160]);
        }
    }
    let mut output = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut output, size, size);
        encoder.set_color(png::ColorType::Rgb);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().expect("png header");
        writer.write_image_data(&pixels).expect("png data");
    }
    output
}

/// 生成遮罩：整张不透明，只有中间的竖直band 是 alpha=0（可重绘）。
fn synth_mask_png(size: u32, band: (u32, u32)) -> Vec<u8> {
    let mut pixels = Vec::with_capacity((size * size * 4) as usize);
    for _y in 0..size {
        for x in 0..size {
            // 透明 = 重绘（OpenAI 约定），RGB 仍是纯黑，方便同时验证亮度不会被误判。
            let alpha = if x >= band.0 && x < band.1 { 0 } else { 255 };
            pixels.extend_from_slice(&[0, 0, 0, alpha]);
        }
    }
    let mut output = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut output, size, size);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().expect("png header");
        writer.write_image_data(&pixels).expect("png data");
    }
    output
}

/// 亮度遮罩：白色 = 重绘（stable-diffusion.cpp 原生 img_gen 约定），其余纯黑不透明。
fn synth_luminance_mask_png(size: u32, band: (u32, u32)) -> Vec<u8> {
    let mut pixels = Vec::with_capacity((size * size * 3) as usize);
    for _y in 0..size {
        for x in 0..size {
            let value = if x >= band.0 && x < band.1 { 255 } else { 0 };
            pixels.extend_from_slice(&[value, value, value]);
        }
    }
    let mut output = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut output, size, size);
        encoder.set_color(png::ColorType::Rgb);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().expect("png header");
        writer.write_image_data(&pixels).expect("png data");
    }
    output
}

fn decode_png_rgba(bytes: &[u8]) -> Result<(u32, u32, Vec<u8>), String> {
    let decoder = png::Decoder::new(std::io::Cursor::new(bytes));
    let mut reader = decoder
        .read_info()
        .map_err(|error| format!("result is not a decodable PNG: {error}"))?;
    let mut buffer = vec![0; reader.output_buffer_size().ok_or("PNG size is unknown")?];
    let info = reader
        .next_frame(&mut buffer)
        .map_err(|error| format!("result PNG frame is broken: {error}"))?;
    buffer.truncate(info.buffer_size());
    let rgba = match info.color_type {
        png::ColorType::Rgba => buffer,
        png::ColorType::Rgb => buffer
            .chunks(3)
            .flat_map(|pixel| [pixel[0], pixel[1], pixel[2], 255])
            .collect(),
        other => return Err(format!("unsupported result color type: {other:?}")),
    };
    Ok((info.width, info.height, rgba))
}

/// 返回（可重绘区域内、区域外）的平均绝对像素差，用来判断遮罩方向。
fn region_diff(before: &[u8], after: &[u8], width: u32, band: (u32, u32)) -> (f64, f64) {
    let mut inside = (0_f64, 0_u64);
    let mut outside = (0_f64, 0_u64);
    for (index, (left, right)) in before.chunks(4).zip(after.chunks(4)).enumerate() {
        let x = (index as u32) % width;
        let delta = (0..3)
            .map(|channel| (left[channel] as f64 - right[channel] as f64).abs())
            .sum::<f64>()
            / 3.0;
        if x >= band.0 && x < band.1 {
            inside.0 += delta;
            inside.1 += 1;
        } else {
            outside.0 += delta;
            outside.1 += 1;
        }
    }
    (
        inside.0 / inside.1.max(1) as f64,
        outside.0 / outside.1.max(1) as f64,
    )
}

async fn run_inpaint_channel(
    harness: &Harness,
    channel: &str,
    provider: &ImageProviderConfig,
    size: u32,
) -> Value {
    let started = Instant::now();
    let band = (size / 3, size * 2 / 3);
    let source = synth_source_png(size);
    let mask = synth_mask_png(size, band);
    let luminance_mask = synth_luminance_mask_png(size, band);
    let source_artifact = harness.write_artifact(&format!("inpaint-{channel}-source.png"), &source);
    let mask_artifact = harness.write_artifact(&format!("inpaint-{channel}-mask.png"), &mask);
    let luma_artifact =
        harness.write_artifact(&format!("inpaint-{channel}-mask-luma.png"), &luminance_mask);
    let prompt = "把遮罩区域重绘成一朵盛开的红色花朵，保持原有光照与插画风格";
    let size_text = format!("{size}x{size}");
    let (bytes, mode) = match execute_inpaint(
        provider,
        prompt,
        &size_text,
        &source,
        "image/png",
        &mask,
        Some(&luminance_mask),
    )
    .await
    {
        Ok(value) => value,
        Err(error) => {
            return json!({
                "channel": channel,
                "ok": false,
                "elapsedMs": started.elapsed().as_millis(),
                "detail": error
            })
        }
    };
    let decoded = match decode_png_rgba(&bytes) {
        Ok(value) => value,
        Err(error) => {
            return json!({
                "channel": channel,
                "ok": false,
                "elapsedMs": started.elapsed().as_millis(),
                "detail": error
            })
        }
    };
    let (width, height, result_pixels) = decoded;
    if (width, height) != (size, size) {
        return json!({
            "channel": channel,
            "ok": false,
            "elapsedMs": started.elapsed().as_millis(),
            "detail": format!("结果尺寸 {width}x{height} 与请求的 {size}x{size} 不一致")
        });
    }
    let (_, _, source_pixels) = decode_png_rgba(&source).expect("source decodes");
    let (inside, outside) = region_diff(&source_pixels, &result_pixels, size, band);
    let artifact = harness.write_artifact(&format!("inpaint-{channel}-result.png"), &bytes);
    let ok = inside >= 8.0 && inside >= outside * 1.5;
    json!({
        "channel": channel,
        "ok": ok,
        "mode": mode,
        "elapsedMs": started.elapsed().as_millis(),
        "detail": format!(
            "{width}x{height} / bandΔ={inside:.2} 外部Δ={outside:.2} / {} bytes",
            bytes.len()
        ),
        "checks": {
            "band": [band.0, band.1],
            "insideDiff": inside,
            "outsideDiff": outside,
            "sha256": sha256_hex(&bytes),
            "source": source_artifact,
            "mask": mask_artifact,
            "luminanceMask": luma_artifact,
            "result": artifact
        }
    })
}

fn inpaint_sd_provider(harness: &Harness) -> ImageProviderConfig {
    let root = harness.model("qwen-image-2.1");
    ImageProviderConfig {
        id: "acceptance-inpaint-sdcpp".to_string(),
        name: "Qwen Image 2.1 · stable-diffusion.cpp".to_string(),
        protocol: "stable-diffusion.cpp".to_string(),
        base_url: "http://127.0.0.1:1234".to_string(),
        model: "sd-cpp-local".to_string(),
        context_size: None,
        inference_backend: Some("gpu".to_string()),
        runtime: Some(LocalRuntimeConfig {
            model_path: None,
            model_directory: Some(root.to_string_lossy().to_string()),
            model_family: None,
            diffusion_model: Some(
                root.join("qwen-image-2.1-turbo-Q4_K_M.gguf")
                    .to_string_lossy()
                    .to_string(),
            ),
            text_encoder: Some(
                root.join("Qwen3-VL-8B-Instruct-Q4_K_M.gguf")
                    .to_string_lossy()
                    .to_string(),
            ),
            llm_vision: None,
            vae: Some(
                root.join("qwen_image_2.1_vae_bf16.safetensors")
                    .to_string_lossy()
                    .to_string(),
            ),
            idle_unload_seconds: Some(600),
        }),
        enabled: true,
        capabilities: vec!["Image".to_string()],
    }
}

const CLOUD_IMAGE_PROVIDER_ID: &str = "acceptance-inpaint-cloud";

fn cloud_inpaint_provider() -> Option<ImageProviderConfig> {
    let key = env::var("KNOWMOTION_ACCEPTANCE_OPENAI_KEY")
        .or_else(|_| env::var("OPENAI_API_KEY"))
        .ok()
        .filter(|value| !value.trim().is_empty())?;
    save_provider_secret(CLOUD_IMAGE_PROVIDER_ID, &key).ok()?;
    Some(ImageProviderConfig {
        id: CLOUD_IMAGE_PROVIDER_ID.to_string(),
        name: "OpenAI Images edits".to_string(),
        protocol: "OpenAI Compatible".to_string(),
        base_url: env::var("KNOWMOTION_ACCEPTANCE_OPENAI_BASE_URL")
            .or_else(|_| env::var("OPENAI_BASE_URL"))
            .unwrap_or_else(|_| "https://api.openai.com/v1".to_string()),
        model: env::var("KNOWMOTION_ACCEPTANCE_OPENAI_IMAGE_MODEL")
            .or_else(|_| env::var("OPENAI_IMAGE_MODEL"))
            .unwrap_or_else(|_| "gpt-image-1".to_string()),
        context_size: None,
        inference_backend: None,
        runtime: None,
        enabled: true,
        capabilities: vec!["Image".to_string()],
    })
}

#[test]
#[ignore = "requires the stable-diffusion.cpp runtime plus a GPU; cloud channel needs an OpenAI key"]
fn real_inpaint_acceptance() {
    let harness = Harness::from_environment();
    harness.configure();
    let size = env::var("KNOWMOTION_ACCEPTANCE_INPAINT_SIZE")
        .ok()
        .and_then(|value| value.parse::<u32>().ok())
        .unwrap_or(512)
        .clamp(256, 1024);
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");

    let mut channels: Vec<Value> = Vec::new();
    let sd_provider = inpaint_sd_provider(&harness);
    println!("[inpaint] stable-diffusion.cpp channel …");
    channels.push(runtime.block_on(run_inpaint_channel(&harness, "sdcpp", &sd_provider, size)));

    match cloud_inpaint_provider() {
        Some(provider) => {
            println!("[inpaint] OpenAI Compatible channel …");
            channels
                .push(runtime.block_on(run_inpaint_channel(&harness, "openai", &provider, size)));
            clear_provider_secret(CLOUD_IMAGE_PROVIDER_ID).ok();
        }
        None => {
            println!(
                "[inpaint] SKIP cloud channel: set KNOWMOTION_ACCEPTANCE_OPENAI_KEY (or OPENAI_API_KEY) to run it"
            );
            channels.push(json!({
                "channel": "openai",
                "ok": false,
                "skipped": true,
                "detail": "未提供云端 Key，未执行 OpenAI Images edits 通道"
            }));
        }
    }

    let report = json!({
        "generatedAt": chrono::Utc::now().to_rfc3339(),
        "size": size,
        "environment": environment_report(),
        "runtimes": runtime_report(&harness),
        "channels": channels
    });
    let path = harness.artifact_path("inpaint-acceptance-report.json");
    fs::write(
        &path,
        serde_json::to_vec_pretty(&report).expect("report json"),
    )
    .expect("write report");
    println!(
        "{}",
        serde_json::to_string_pretty(&report).unwrap_or_default()
    );

    let failed = report["channels"]
        .as_array()
        .map(|entries| {
            entries
                .iter()
                .filter(|entry| {
                    entry.get("ok").and_then(Value::as_bool) != Some(true)
                        && entry.get("skipped").and_then(Value::as_bool) != Some(true)
                })
                .count()
        })
        .unwrap_or(1);
    assert_eq!(failed, 0, "inpaint acceptance has failing channels");
}

// ---------------------------------------------------------------------------
// P0：九 Agent 全流程（Research → Quality）真实 LLM 验收
// ---------------------------------------------------------------------------

#[derive(Default)]
struct RecordingSink {
    events: std::sync::Mutex<Vec<Value>>,
}

impl WorkflowEventSink for RecordingSink {
    fn emit_workflow_event(&self, payload: Value) {
        if let Ok(mut events) = self.events.lock() {
            events.push(payload);
        }
    }
}

impl RecordingSink {
    fn snapshot(&self) -> Vec<Value> {
        self.events
            .lock()
            .map(|events| events.clone())
            .unwrap_or_default()
    }
}

fn acceptance_project() -> Value {
    let now = chrono::Utc::now().to_rfc3339();
    json!({
        "id": "project_acceptance",
        "title": "为什么天空是蓝色的？",
        "createdAt": now,
        "updatedAt": now,
        "stage": "planning",
        "isDemo": false,
        "settings": {
            "topic": "为什么天空是蓝色的？",
            "contentType": "科学原理",
            "audience": "对日常科学好奇的年轻观众",
            "duration": 45,
            "aspectRatio": "16:9",
            "style": "扁平矢量科普动画",
            "language": "简体中文"
        },
        "outline": [],
        "outlineApproved": false,
        "researchSources": [],
        "scenes": [],
        "assets": [],
        "characters": [],
        "locations": [],
        "styleLock": {
            "enabled": true,
            "descriptor": "扁平矢量科普动画，明亮蓝天，圆润几何形状，粗体无衬线标题",
            "palette": ["#8ef2ff", "#58c7ff", "#ffd166", "#c8ff65"],
            "negative": "写实照片，昏暗色调，恐怖氛围，文字水印",
            "referenceAssetIds": []
        },
        "subtitles": [],
        "timeline": [],
        "audio": {
            "voice": "Microsoft Huihui Desktop",
            "rate": 1.0,
            "volume": 0.8,
            "subtitleSize": 32,
            "subtitlePosition": "bottom"
        },
        "renders": []
    })
}

#[test]
#[ignore = "requires the real GGUF LLM runtime; runs nine agents end to end"]
fn real_workflow_acceptance() {
    let harness = Harness::from_environment();
    harness.configure();
    let run_root = harness.out_dir.join("workflow-run");
    let _ = fs::remove_dir_all(&run_root);
    fs::create_dir_all(&run_root).expect("workflow run dir");
    let database_path = run_root.join("workflow.db");
    let projects_root = run_root.join("projects");

    let runtime = AgentRuntime::new(&database_path, projects_root.clone()).expect("agent runtime");
    let sink = Arc::new(RecordingSink::default());

    let model = harness.model("Qwen3.8-27B/Qwen3.8-27B-UD-IQ2_S.gguf");
    if !model.is_file() {
        panic!("LLM model is missing: {}", model.display());
    }
    let provider = ProviderConfig {
        id: "acceptance-workflow-llm".to_string(),
        name: "Qwen3.8-27B · Vulkan".to_string(),
        protocol: "GGUF".to_string(),
        base_url: model.to_string_lossy().to_string(),
        model: "Qwen3.8-27B-UD-IQ2_S".to_string(),
        context_size: Some(16384),
        inference_backend: Some("gpu".to_string()),
        runtime: None,
        enabled: true,
        capabilities: vec!["LLM".to_string()],
    };
    let mut routes = std::collections::BTreeMap::new();
    for agent_key in [
        "research",
        "director",
        "script",
        "storyboard",
        "art_director",
        "asset",
        "animation",
        "audio",
        "quality",
    ] {
        routes.insert(
            agent_key.to_string(),
            AgentModelRoute {
                provider_id: provider.id.clone(),
                model: None,
            },
        );
    }

    let started = Instant::now();
    let mut run = runtime
        .create_run(
            sink.clone(),
            WorkflowStartRequest {
                project: acceptance_project(),
                providers: vec![provider.clone()],
                agent_routes: routes,
                instruction: Some(
                    "面向普通观众解释天空为什么是蓝色的，45 秒，四个场景以内。".to_string(),
                ),
                max_attempts: Some(2),
                target_agent: None,
                auto_mode: false,
            },
        )
        .expect("create run");
    println!("[workflow] run {} created", run.id);

    let deadline = Instant::now() + Duration::from_secs(150 * 60);
    let mut approvals = 0_u32;
    loop {
        if Instant::now() > deadline {
            panic!(
                "workflow did not finish within 150 minutes; last status {}",
                run.status
            );
        }
        match run.status.as_str() {
            "completed" => break,
            "failed" => panic!("workflow failed: {}", run.error.clone().unwrap_or_default()),
            "waiting_approval" => {
                let step = run
                    .steps
                    .iter()
                    .find(|step| step.status == "waiting_approval")
                    .map(|step| step.key.clone());
                let Some(step_key) = step else {
                    panic!("run is waiting for approval but no step is pending");
                };
                approvals += 1;
                println!("[workflow] approving {step_key} ({approvals})");
                run = runtime
                    .approve(
                        sink.clone(),
                        &run.id,
                        &step_key,
                        "approve",
                        Some("accepted by acceptance run".to_string()),
                    )
                    .expect("approve step");
            }
            _ => {}
        }
        std::thread::sleep(Duration::from_secs(3));
        run = runtime.get_run(&run.id).expect("refresh run");
    }

    let project = run.project.clone().unwrap_or_else(|| json!({}));
    let scenes = project
        .get("scenes")
        .and_then(Value::as_array)
        .map(Vec::len)
        .unwrap_or(0);
    let outlines = project
        .get("outline")
        .and_then(Value::as_array)
        .map(Vec::len)
        .unwrap_or(0);
    let subtitles = project
        .get("subtitles")
        .and_then(Value::as_array)
        .map(Vec::len)
        .unwrap_or(0);
    let timeline = project
        .get("timeline")
        .and_then(Value::as_array)
        .map(Vec::len)
        .unwrap_or(0);
    let assets = project
        .get("assets")
        .and_then(Value::as_array)
        .map(Vec::len)
        .unwrap_or(0);
    let quality = project.get("qualityReport").cloned().unwrap_or(Value::Null);
    let quality_status = quality
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("missing")
        .to_string();
    let quality_score = quality.get("score").and_then(Value::as_f64).unwrap_or(0.0);

    // Provider 调用记录直接查库，避免“步骤完成但其实没调模型”的假通过。
    let provider_calls = rusqlite::Connection::open(&database_path)
        .ok()
        .and_then(|database| {
            database
                .query_row("SELECT COUNT(*) FROM provider_calls", [], |row| {
                    row.get::<_, i64>(0)
                })
                .ok()
        })
        .unwrap_or(0);
    let step_rows: Vec<Value> = {
        let database = rusqlite::Connection::open(&database_path).expect("open workflow db");
        let mut statement = database
            .prepare(
                "SELECT step_key, status, attempt, approval_status, error_message FROM workflow_steps ORDER BY step_key",
            )
            .expect("prepare steps");
        statement
            .query_map([], |row| {
                Ok(json!({
                    "key": row.get::<_, String>(0)?,
                    "status": row.get::<_, String>(1)?,
                    "attempt": row.get::<_, u32>(2)?,
                    "approval": row.get::<_, Option<String>>(3)?,
                    "error": row.get::<_, Option<String>>(4)?
                }))
            })
            .expect("query steps")
            .flatten()
            .collect()
    };
    let failed_steps = step_rows
        .iter()
        .filter(|step| step["status"] != "completed")
        .count();

    let report = json!({
        "generatedAt": chrono::Utc::now().to_rfc3339(),
        "runId": run.id,
        "status": run.status,
        "elapsedMs": started.elapsed().as_millis(),
        "approvals": approvals,
        "providerCalls": provider_calls,
        "project": {
            "outlineSections": outlines,
            "scenes": scenes,
            "assets": assets,
            "subtitles": subtitles,
            "timelineClips": timeline,
            "quality": quality
        },
        "steps": step_rows,
        "events": sink.snapshot().len(),
        "environment": environment_report(),
        "runtimes": runtime_report(&harness)
    });
    let path = harness.artifact_path("workflow-acceptance-report.json");
    fs::write(
        &path,
        serde_json::to_vec_pretty(&report).expect("report json"),
    )
    .expect("write report");
    fs::write(
        harness.artifact_path("workflow-acceptance-project.json"),
        serde_json::to_vec_pretty(&project).expect("project json"),
    )
    .expect("write project");
    println!(
        "{}",
        serde_json::to_string_pretty(&report).unwrap_or_default()
    );

    assert_eq!(run.status, "completed", "workflow must complete");
    assert!(
        failed_steps == 0,
        "every step must complete: {failed_steps} failed"
    );
    assert!(outlines > 0, "outline must not be empty");
    assert!(scenes > 0, "storyboard must produce scenes");
    assert!(subtitles > 0, "audio agent must produce subtitles");
    assert!(
        provider_calls >= 9,
        "expected at least nine LLM calls, saw {provider_calls}"
    );
    assert!(quality_status != "missing", "quality report is missing");
    assert!(
        matches!(quality_status.as_str(), "pass" | "warn" | "fail"),
        "unexpected quality status {quality_status} ({quality_score})"
    );
    assert!(quality_score > 0.0, "quality score must be positive");
}

// ---------------------------------------------------------------------------
// P0：第三方云端 Image / TTS / ASR / Embedding 凭据验收
// ---------------------------------------------------------------------------

struct CloudConfig {
    base_url: String,
    api_key: String,
    image_model: String,
    tts_model: String,
    tts_voice: String,
    asr_model: String,
    embedding_model: String,
}

impl CloudConfig {
    fn from_environment() -> Option<Self> {
        let api_key = env::var("KNOWMOTION_ACCEPTANCE_OPENAI_KEY")
            .or_else(|_| env::var("OPENAI_API_KEY"))
            .ok()
            .filter(|value| !value.trim().is_empty())?;
        let base_url = env::var("KNOWMOTION_ACCEPTANCE_OPENAI_BASE_URL")
            .or_else(|_| env::var("OPENAI_BASE_URL"))
            .unwrap_or_else(|_| "https://api.openai.com/v1".to_string());
        Some(Self {
            base_url,
            api_key,
            image_model: env::var("KNOWMOTION_ACCEPTANCE_OPENAI_IMAGE_MODEL")
                .or_else(|_| env::var("OPENAI_IMAGE_MODEL"))
                .unwrap_or_else(|_| "gpt-image-1".to_string()),
            tts_model: env::var("KNOWMOTION_ACCEPTANCE_OPENAI_TTS_MODEL")
                .unwrap_or_else(|_| "gpt-4o-mini-tts".to_string()),
            tts_voice: env::var("KNOWMOTION_ACCEPTANCE_OPENAI_TTS_VOICE")
                .unwrap_or_else(|_| "alloy".to_string()),
            asr_model: env::var("KNOWMOTION_ACCEPTANCE_OPENAI_ASR_MODEL")
                .unwrap_or_else(|_| "whisper-1".to_string()),
            embedding_model: env::var("KNOWMOTION_ACCEPTANCE_OPENAI_EMBEDDING_MODEL")
                .unwrap_or_else(|_| "text-embedding-3-small".to_string()),
        })
    }

    fn provider(&self, id: &str, capability: &str) -> ImageProviderConfig {
        ImageProviderConfig {
            id: id.to_string(),
            name: format!("OpenAI {capability}"),
            protocol: "OpenAI Compatible".to_string(),
            base_url: self.base_url.clone(),
            model: match capability {
                "Image" => self.image_model.clone(),
                "TTS" => self.tts_model.clone(),
                "ASR" => self.asr_model.clone(),
                _ => self.embedding_model.clone(),
            },
            context_size: None,
            inference_backend: None,
            runtime: None,
            enabled: true,
            capabilities: vec![capability.to_string()],
        }
    }
}

#[test]
#[ignore = "requires third-party cloud credentials (OpenAI Compatible)"]
fn real_cloud_acceptance() {
    let harness = Harness::from_environment();
    harness.configure();
    let Some(cloud) = CloudConfig::from_environment() else {
        panic!(
            "云端验收需要 API Key：设置 KNOWMOTION_ACCEPTANCE_OPENAI_KEY（或 OPENAI_API_KEY）。\
             可选 KNOWMOTION_ACCEPTANCE_OPENAI_BASE_URL / _IMAGE_MODEL / _TTS_MODEL / _ASR_MODEL / _EMBEDDING_MODEL。"
        );
    };

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    let mut checks: Vec<Value> = Vec::new();
    let mut record = |name: &str, result: Result<Value, String>| {
        match result {
            Ok(detail) => checks.push(json!({"capability": name, "ok": true, "detail": detail})),
            Err(error) => checks.push(json!({"capability": name, "ok": false, "detail": error})),
        };
    };

    // 1. Embedding
    let embedding_provider = cloud.provider("acceptance-cloud-embedding", "Embedding");
    save_provider_secret(&embedding_provider.id, &cloud.api_key).ok();
    let embedding = runtime.block_on(async {
        let query = "为什么傍晚的天空会变红".to_string();
        let related = "傍晚阳光穿过更厚的大气层，蓝光被散射掉，只剩红光。".to_string();
        let unrelated = "用透视表按季度汇总各区域销售额。".to_string();
        let vectors = request_embeddings(
            &embedding_provider,
            &[query, related, unrelated],
        )
        .await?;
        let dimensions = vectors.first().map(Vec::len).unwrap_or(0);
        if dimensions == 0 || vectors.iter().any(|vector| vector.len() != dimensions) {
            return Err("Embedding 向量维度不一致".to_string());
        }
        let near = cosine_similarity(&vectors[0], &vectors[1]).unwrap_or(f64::NEG_INFINITY);
        let far = cosine_similarity(&vectors[0], &vectors[2]).unwrap_or(f64::INFINITY);
        if !matches!(
            near.partial_cmp(&(far + 0.02)),
            Some(std::cmp::Ordering::Greater)
        ) {
            return Err(format!("语义排序不成立：相关 {near:.4} 无关 {far:.4}"));
        }
        Ok(json!({"model": embedding_provider.model, "dimensions": dimensions, "related": near, "unrelated": far}))
    });
    record("Embedding", embedding);

    // 2. TTS
    let tts_provider = cloud.provider("acceptance-cloud-tts", "TTS");
    save_provider_secret(&tts_provider.id, &cloud.api_key).ok();
    let tts = runtime.block_on(async {
        let bytes =
            synthesize_speech(&tts_provider, None, NARRATION, &cloud.tts_voice, 1.0).await?;
        let duration = wav_duration_ms(&bytes)?;
        if duration < 1500 {
            return Err(format!("云端 TTS 音频过短：{duration} ms"));
        }
        harness.write_artifact("cloud-narration.wav", &bytes);
        Ok(json!({"model": tts_provider.model, "durationMs": duration, "bytes": bytes.len()}))
    });
    record("TTS", tts);

    // 3. ASR（吃上一步的真实音频）
    let asr_provider = cloud.provider("acceptance-cloud-asr", "ASR");
    save_provider_secret(&asr_provider.id, &cloud.api_key).ok();
    let asr = runtime.block_on(async {
        let audio = fs::read(harness.artifact_path("cloud-narration.wav"))
            .map_err(|error| format!("TTS 产物不可用：{error}"))?;
        let (text, cues) = transcribe_audio(&asr_provider, None, "cloud-narration.wav", &audio).await?;
        if text.trim().is_empty() {
            return Err("云端 ASR 返回空文本".to_string());
        }
        let overlap = char_overlap(NARRATION, &text);
        if overlap < 0.4 {
            return Err(format!("ASR 文本与旁白差异过大（{overlap:.3}）：{text}"));
        }
        Ok(json!({"model": asr_provider.model, "text": text, "cues": cues.len(), "charOverlap": overlap}))
    });
    record("ASR", asr);

    // 4. Image
    let image_provider = cloud.provider("acceptance-cloud-image", "Image");
    save_provider_secret(&image_provider.id, &cloud.api_key).ok();
    let image = runtime.block_on(async {
        let (images, mode) = generate_images_for_provider(
            &image_provider,
            "傍晚海面日落，扁平矢量插画，干净构图",
            "1024x1024",
            1,
        )
        .await?;
        let bytes = images.into_iter().next().ok_or_else(|| "云端图片服务没有返回图像".to_string())?;
        let (width, height) = png_dimensions(&bytes)?;
        let artifact = harness.write_artifact("cloud-image.png", &bytes);
        Ok(json!({"model": image_provider.model, "mode": mode, "width": width, "height": height, "bytes": bytes.len(), "sha256": sha256_hex(&bytes), "artifact": artifact}))
    });
    record("Image", image);

    // 5. 局部重绘（云端 images/edits，同一张源图 + alpha 遮罩）
    let inpaint = runtime.block_on(async {
        let source = fs::read(harness.artifact_path("cloud-image.png"))
            .map_err(|error| format!("云端图片产物不可用：{error}"))?;
        let (width, height) = png_dimensions(&source)?;
        let band = (width / 3, width * 2 / 3);
        let alpha_mask = synth_mask_png(width.max(height), band);
        let luminance_mask = synth_luminance_mask_png(width.max(height), band);
        // 云端源图是正方形；非正方形时直接拒绝，避免遮罩尺寸不符。
        if width != height {
            return Err(format!("云端图片不是正方形（{width}x{height}），无法构造同尺寸遮罩"));
        }
        let (bytes, mode) = execute_inpaint(
            &image_provider,
            "把遮罩区域重绘成一朵红色花朵，保持原有光照与插画风格",
            &format!("{width}x{height}"),
            &source,
            "image/png",
            &alpha_mask,
            Some(&luminance_mask),
        )
        .await?;
        let (result_width, result_height, _) = decode_png_rgba(&bytes)?;
        let artifact = harness.write_artifact("cloud-inpaint.png", &bytes);
        Ok(json!({"mode": mode, "width": result_width, "height": result_height, "bytes": bytes.len(), "sha256": sha256_hex(&bytes), "artifact": artifact}))
    });
    record("Inpaint", inpaint);

    for provider in [
        "acceptance-cloud-embedding",
        "acceptance-cloud-tts",
        "acceptance-cloud-asr",
    ] {
        clear_provider_secret(provider).ok();
    }

    let failed = checks
        .iter()
        .filter(|check| check["ok"] != json!(true))
        .count();
    let report = json!({
        "generatedAt": chrono::Utc::now().to_rfc3339(),
        "baseUrl": cloud.base_url,
        "models": {
            "image": cloud.image_model,
            "tts": cloud.tts_model,
            "asr": cloud.asr_model,
            "embedding": cloud.embedding_model
        },
        "summary": {"total": checks.len(), "failed": failed},
        "checks": checks
    });
    let path = harness.artifact_path("cloud-acceptance-report.json");
    fs::write(
        &path,
        serde_json::to_vec_pretty(&report).expect("report json"),
    )
    .expect("write report");
    println!(
        "{}",
        serde_json::to_string_pretty(&report).unwrap_or_default()
    );
    assert_eq!(failed, 0, "cloud acceptance has failing capabilities");
}

#[test]
#[ignore = "requires the real GGUF LLM runtime"]
fn real_gguf_json_acceptance() {
    // 结构化 JSON 生成必须返回非空 content。Qwen3 系默认开启 thinking 时，
    // 思维链会吃光 max_tokens 并把 content 留空——本用例就是那条回归。
    let harness = Harness::from_environment();
    harness.configure();
    let model = harness.model("Qwen3.8-27B/Qwen3.8-27B-UD-IQ2_S.gguf");
    assert!(model.is_file(), "LLM model is missing: {}", model.display());
    let config = ProviderConfig {
        id: "acceptance-json-llm".to_string(),
        name: "Qwen3.8-27B · Vulkan".to_string(),
        protocol: "GGUF".to_string(),
        base_url: model.to_string_lossy().to_string(),
        model: "Qwen3.8-27B-UD-IQ2_S".to_string(),
        context_size: Some(8192),
        inference_backend: Some("gpu".to_string()),
        runtime: None,
        enabled: true,
        capabilities: vec!["LLM".to_string()],
    };
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    let started = Instant::now();
    let response = runtime.block_on(async {
        let provider = resolve_provider(&config, None).await?;
        let result = provider
            .complete(LlmRequest {
                model: config.model.clone(),
                system: "你是分镜 Agent。只输出 JSON，对象字段固定为 {\"tool\":\"replaceScenes\",\"input\":{\"scenes\":[{\"id\":\"s1\",\"title\":\"标题\",\"narration\":\"旁白\",\"visualPrompt\":\"画面\",\"duration\":6}]}}。".to_string(),
                user: "为「为什么天空是蓝色的？」写 4 个镜头，每个镜头旁白 20-40 个汉字。".to_string(),
                temperature: 0.35,
                max_tokens: 6000,
                json_mode: true,
            })
            .await?;
        drop(provider);
        Ok::<_, String>(result)
    });
    crate::agent::shutdown_llama_runtime();
    let response = response.expect("GGUF structured completion");
    assert!(
        !response.text.trim().is_empty(),
        "structured completion returned empty content"
    );
    let parsed: Value = serde_json::from_str(response.text.trim()).unwrap_or_else(|error| {
        panic!(
            "output is not JSON ({error}): {}",
            tail(&response.text, 400)
        )
    });
    let scenes = parsed
        .pointer("/input/scenes")
        .and_then(Value::as_array)
        .map(Vec::len)
        .unwrap_or(0);
    assert!(
        scenes > 0,
        "expected a scenes array, got: {}",
        tail(&response.text, 400)
    );
    let report = json!({
        "ok": true,
        "elapsedMs": started.elapsed().as_millis(),
        "inputTokens": response.input_tokens,
        "outputTokens": response.output_tokens,
        "scenes": scenes,
        "artifact": harness.write_artifact("gguf-json-acceptance.json", response.text.as_bytes())
    });
    println!(
        "{}",
        serde_json::to_string_pretty(&report).unwrap_or_default()
    );
}

fn environment_report() -> Value {
    let gpu = command_text(
        "nvidia-smi",
        &[
            "--query-gpu=name,driver_version,memory.total",
            "--format=csv,noheader",
        ],
    );
    json!({
        "os": env::consts::OS,
        "arch": env::consts::ARCH,
        "gpu": gpu.lines().next().unwrap_or_default().trim(),
        "nvidiaSmi": gpu.trim()
    })
}

fn runtime_report(harness: &Harness) -> Value {
    let mut entries = serde_json::Map::new();
    for runtime in ["llama.cpp", "audio.cpp", "stable-diffusion.cpp"] {
        let executable = local_runtime::installed_executable(runtime);
        entries.insert(
            runtime.to_string(),
            json!({
                "installed": executable.is_some(),
                "executable": executable.map(|path| path.to_string_lossy().to_string()),
                "acceleration": local_runtime::installed_acceleration(runtime),
                "root": harness.data_dir.join("runtimes").join(runtime).to_string_lossy().to_string()
            }),
        );
    }
    Value::Object(entries)
}

fn free_loopback_port() -> Result<u16, String> {
    TcpListener::bind(("127.0.0.1", 0))
        .and_then(|listener| listener.local_addr())
        .map(|address| address.port())
        .map_err(|error| format!("Unable to reserve a loopback port: {error}"))
}

async fn wait_for_http(url: &str, timeout: Duration) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|error| error.to_string())?;
    while Instant::now() < deadline {
        let response = client.get(url).send().await;
        if response.is_ok_and(|response| response.status().is_success()) {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
    Err(format!("{url} did not become ready within {timeout:?}"))
}

fn png_dimensions(bytes: &[u8]) -> Result<(u32, u32), String> {
    if bytes.len() < 24 || !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Err("图片服务返回的不是 PNG".to_string());
    }
    let width = u32::from_be_bytes([bytes[16], bytes[17], bytes[18], bytes[19]]);
    let height = u32::from_be_bytes([bytes[20], bytes[21], bytes[22], bytes[23]]);
    if width == 0 || height == 0 {
        return Err("PNG 尺寸为 0".to_string());
    }
    Ok((width, height))
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    hex::encode(Sha256::digest(bytes))
}

fn char_overlap(expected: &str, actual: &str) -> f64 {
    let expected_chars = expected
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect::<Vec<_>>();
    if expected_chars.is_empty() {
        return 0.0;
    }
    let actual_chars = actual.chars().collect::<std::collections::HashSet<_>>();
    let hits = expected_chars
        .iter()
        .filter(|character| actual_chars.contains(character))
        .count();
    hits as f64 / expected_chars.len() as f64
}

fn tail(text: &str, limit: usize) -> String {
    let characters = text.chars().collect::<Vec<_>>();
    characters[characters.len().saturating_sub(limit)..]
        .iter()
        .collect()
}

fn command_text(program: &str, args: &[&str]) -> String {
    let mut command = Command::new(program);
    command.args(args).stdin(Stdio::null());
    hide_console(&mut command);
    match command.output() {
        Ok(output) => String::from_utf8_lossy(&output.stdout).to_string(),
        Err(_) => String::new(),
    }
}

#[cfg(windows)]
fn hide_console(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn hide_console(_command: &mut Command) {}
