use super::model::ProviderConfig;
use super::provider::{LlmProvider, LlmRequest, LlmResponse};
use async_trait::async_trait;
#[cfg(target_os = "windows")]
use llama_rs::backend::dx12::{Dx12Backend, Dx12DeviceType};
use llama_rs::{ChatTemplate, Engine, EngineConfig, Sampler, SamplerConfig};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
};

struct CachedEngine {
    context_size: usize,
    preference: BackendPreference,
    backend_label: String,
    engine: Arc<Engine>,
}

static ENGINE_CACHE: OnceLock<Mutex<HashMap<PathBuf, CachedEngine>>> = OnceLock::new();

pub struct GgufLlmProvider {
    engine: Arc<Engine>,
    model_name: String,
    backend_label: String,
}

impl GgufLlmProvider {
    pub fn load(config: &ProviderConfig) -> Result<Self, String> {
        let (engine, backend_label) = load_cached_engine(config)?;
        Ok(Self {
            engine,
            model_name: config.model.clone(),
            backend_label,
        })
    }
}

#[async_trait]
impl LlmProvider for GgufLlmProvider {
    async fn complete(&self, request: LlmRequest) -> Result<LlmResponse, String> {
        let engine = Arc::clone(&self.engine);
        let requested_model = if request.model.trim().is_empty() {
            self.model_name.clone()
        } else {
            request.model.clone()
        };
        let result = tokio::task::spawn_blocking(move || generate_text(&engine, &request))
            .await
            .map_err(|error| format!("GGUF inference task failed: {error}"))??;
        Ok(LlmResponse {
            text: result.text,
            model: requested_model,
            input_tokens: Some(result.input_tokens as u64),
            output_tokens: Some(result.output_tokens as u64),
        })
    }

    fn backend_label(&self) -> Option<&str> {
        Some(&self.backend_label)
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
            "gpu" | "dx12" => Ok(Self::Gpu),
            "cpu" => Ok(Self::Cpu),
            other => Err(format!("Unsupported GGUF inference backend: {other}")),
        }
    }
}

fn load_cached_engine(config: &ProviderConfig) -> Result<(Arc<Engine>, String), String> {
    let model_path = validate_model_path(&config.base_url)?;
    let context_size = config.context_size.unwrap_or(8192).clamp(512, 1_048_576) as usize;
    let preference = BackendPreference::from_config(config.inference_backend.as_deref())?;
    let cache = ENGINE_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some(cached) = cache
        .lock()
        .map_err(|_| "GGUF model cache is unavailable".to_string())?
        .get(&model_path)
    {
        if cached.context_size == context_size && cached.preference == preference {
            return Ok((Arc::clone(&cached.engine), cached.backend_label.clone()));
        }
    }

    let gpu_name = dx12_gpu_name();
    let use_gpu = match preference {
        BackendPreference::Cpu => false,
        BackendPreference::Gpu => {
            if gpu_name.is_none() {
                return Err(
                    "DirectX 12 GPU inference was requested, but no compatible GPU was detected"
                        .to_string(),
                );
            }
            true
        }
        BackendPreference::Auto => gpu_name.is_some(),
    };
    let backend_label = if use_gpu {
        format!(
            "DirectX 12 GPU · {}",
            gpu_name.as_deref().unwrap_or("unknown device")
        )
    } else {
        "CPU".to_string()
    };
    let engine_config = EngineConfig {
        model_path: model_path.to_string_lossy().to_string(),
        temperature: 0.35,
        top_k: 40,
        top_p: 0.95,
        repeat_penalty: 1.1,
        max_tokens: 6000,
        max_context_len: Some(context_size),
        use_gpu,
        ..EngineConfig::default()
    };
    let (engine, backend_label) = match Engine::load(engine_config.clone()) {
        Ok(engine) => (Arc::new(engine), backend_label),
        Err(error) if preference == BackendPreference::Auto && engine_config.use_gpu => {
            let cpu_config = EngineConfig {
                use_gpu: false,
                ..engine_config
            };
            (
                Arc::new(Engine::load(cpu_config).map_err(|fallback_error| {
                    format!("Unable to load GGUF model on GPU ({error}) or CPU ({fallback_error})")
                })?),
                "CPU (GPU initialization failed)".to_string(),
            )
        }
        Err(error) => return Err(format!("Unable to load GGUF model: {error}")),
    };
    cache
        .lock()
        .map_err(|_| "GGUF model cache is unavailable".to_string())?
        .insert(
            model_path,
            CachedEngine {
                context_size,
                preference,
                backend_label: backend_label.clone(),
                engine: Arc::clone(&engine),
            },
        );
    Ok((engine, backend_label))
}

fn dx12_gpu_name() -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        let backend = Dx12Backend::new().ok()?;
        let has_hardware = Dx12Backend::enumerate_devices()
            .into_iter()
            .any(|device| !matches!(device.device_type, Dx12DeviceType::Warp));
        has_hardware.then(|| backend.device_name().to_string())
    }
    #[cfg(not(target_os = "windows"))]
    {
        None
    }
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

struct GeneratedText {
    text: String,
    input_tokens: usize,
    output_tokens: usize,
}

fn generate_text(engine: &Engine, request: &LlmRequest) -> Result<GeneratedText, String> {
    let mut user = request.user.clone();
    if request.json_mode {
        user.push_str(
            "\n\n严格输出要求：只返回一个完整、可解析的 JSON 对象，不要使用 Markdown 代码围栏。",
        );
    }
    let prompt = engine
        .chat_template()
        .format_first_turn(&request.system, &user);
    let tokenizer = engine.tokenizer();
    let mut tokens = tokenizer
        .encode(&prompt, engine.add_bos())
        .map_err(|error| format!("Unable to tokenize GGUF prompt: {error}"))?;
    if tokens.is_empty() {
        return Err("GGUF tokenizer produced an empty prompt".to_string());
    }

    let context_limit = engine.model_config().max_seq_len;
    if tokens.len() >= context_limit {
        return Err(format!(
            "GGUF prompt uses {} tokens but the configured context is {} tokens. Increase context length or reduce project context.",
            tokens.len(),
            context_limit
        ));
    }
    let max_new_tokens =
        (request.max_tokens.max(1) as usize).min(context_limit.saturating_sub(tokens.len()));
    let input_tokens = tokens.len();
    let mut sampler = Sampler::new(
        SamplerConfig {
            temperature: request.temperature.max(0.0),
            top_k: if request.temperature <= 0.0 { 1 } else { 40 },
            top_p: 0.95,
            repeat_penalty: if request.temperature <= 0.0 { 1.0 } else { 1.1 },
            ..SamplerConfig::default()
        },
        engine.model_config().vocab_size,
    );
    let mut context = engine.create_inference_context();
    let eos_token = tokenizer.special_tokens.eos_token_id;
    let mut output = String::new();

    for _ in 0..max_new_tokens {
        let logits = if context.position == 0 {
            engine
                .model()
                .forward(&tokens, &mut context)
                .map_err(|error| format!("GGUF model forward pass failed: {error}"))?
        } else {
            engine
                .model()
                .forward(&tokens[tokens.len() - 1..], &mut context)
                .map_err(|error| format!("GGUF model forward pass failed: {error}"))?
        };
        let next_token = sampler.sample(&logits, &tokens);
        if next_token == eos_token {
            break;
        }
        let text = tokenizer
            .decode(&[next_token])
            .map_err(|error| format!("Unable to decode GGUF output token: {error}"))?;
        output.push_str(&text);
        tokens.push(next_token);

        if truncate_at_stop(engine.chat_template(), &mut output) {
            break;
        }
    }

    if output.trim().is_empty() {
        return Err("GGUF model returned no text".to_string());
    }
    Ok(GeneratedText {
        text: output.trim().to_string(),
        input_tokens,
        output_tokens: tokens.len().saturating_sub(input_tokens),
    })
}

fn truncate_at_stop(template: &ChatTemplate, output: &mut String) -> bool {
    let positions = template
        .stop_patterns()
        .iter()
        .filter_map(|pattern| output.find(pattern))
        .collect::<Vec<_>>();
    if let Some(position) = positions.into_iter().min() {
        output.truncate(position);
        true
    } else {
        false
    }
}

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
    #[ignore = "requires KNOWMOTION_GGUF_TEST_MODEL"]
    fn generates_text_with_a_real_gguf_model() {
        let model_path = std::env::var("KNOWMOTION_GGUF_TEST_MODEL").expect("GGUF test model path");
        let config = ProviderConfig {
            id: "gguf-test".to_string(),
            name: "GGUF test".to_string(),
            protocol: "GGUF".to_string(),
            base_url: model_path,
            model: "test".to_string(),
            context_size: Some(512),
            inference_backend: Some("cpu".to_string()),
            enabled: true,
            capabilities: vec!["LLM".to_string()],
        };
        let provider = GgufLlmProvider::load(&config).expect("load GGUF model");
        let result = generate_text(
            &provider.engine,
            &LlmRequest {
                model: "test".to_string(),
                system: "You are a concise assistant.".to_string(),
                user: "Reply with the single word: hello".to_string(),
                temperature: 0.0,
                max_tokens: 16,
                json_mode: false,
            },
        )
        .expect("generate GGUF response");
        assert!(!result.text.trim().is_empty());
        assert!(result.input_tokens > 0);
        assert!(result.output_tokens > 0);
    }

    #[test]
    #[ignore = "requires KNOWMOTION_GGUF_TEST_MODEL and a DirectX 12 GPU"]
    fn generates_text_with_a_real_gguf_model_on_gpu() {
        let model_path = std::env::var("KNOWMOTION_GGUF_TEST_MODEL").expect("GGUF test model path");
        let config = ProviderConfig {
            id: "gguf-gpu-test".to_string(),
            name: "GGUF GPU test".to_string(),
            protocol: "GGUF".to_string(),
            base_url: model_path,
            model: "test".to_string(),
            context_size: Some(512),
            inference_backend: Some("gpu".to_string()),
            enabled: true,
            capabilities: vec!["LLM".to_string()],
        };
        let provider = GgufLlmProvider::load(&config).expect("load GGUF model on GPU");
        assert!(provider
            .backend_label()
            .is_some_and(|label| label.starts_with("DirectX 12 GPU")));
        let result = generate_text(
            &provider.engine,
            &LlmRequest {
                model: "test".to_string(),
                system: "You are a concise assistant.".to_string(),
                user: "Reply with the single word: hello".to_string(),
                temperature: 0.0,
                max_tokens: 16,
                json_mode: false,
            },
        )
        .expect("generate GGUF response on GPU");
        assert!(!result.text.trim().is_empty());
        assert!(result.output_tokens > 0);
    }
}
