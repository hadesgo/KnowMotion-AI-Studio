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
        clear_provider_secret, resolve_provider, save_provider_secret, LlmRequest, ProviderConfig,
    },
    capabilities::{
        cosine_similarity, generate_images_for_provider, request_embeddings, synthesize_speech,
        transcribe_audio, wav_duration_ms, ImageProviderConfig,
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
        if !(near > far + 0.02) {
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
        inference_backend: Some("gpu".to_string()),
        runtime: Some(LocalRuntimeConfig {
            model_path: Some(harness.model(model_file).to_string_lossy().to_string()),
            model_directory: None,
            model_family: Some(family.to_string()),
            diffusion_model: None,
            text_encoder: None,
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
