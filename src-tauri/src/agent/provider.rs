use super::gguf::GgufLlmProvider;
use super::model::{ProviderConfig, ProviderTestResult};
use async_trait::async_trait;
use keyring::Entry;
use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use reqwest::{Client, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::{Duration, Instant};

const KEYRING_SERVICE: &str = "com.knowmotion.studio.provider";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlmRequest {
    pub model: String,
    pub system: String,
    pub user: String,
    pub temperature: f32,
    pub max_tokens: u32,
    pub json_mode: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmResponse {
    pub text: String,
    pub model: String,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
}

#[async_trait]
pub trait LlmProvider: Send + Sync {
    async fn complete(&self, request: LlmRequest) -> Result<LlmResponse, String>;

    fn backend_label(&self) -> Option<&str> {
        None
    }
}

pub struct HttpLlmProvider {
    config: ProviderConfig,
    secret: Option<String>,
    client: Client,
}

impl HttpLlmProvider {
    pub fn new(config: ProviderConfig, secret: Option<String>) -> Result<Self, String> {
        let client = Client::builder()
            .timeout(Duration::from_secs(120))
            .connect_timeout(Duration::from_secs(15))
            .user_agent("KnowMotion-AI-Studio/0.1")
            .build()
            .map_err(|error| format!("Unable to create provider client: {error}"))?;
        Ok(Self {
            config,
            secret,
            client,
        })
    }

    fn normalize_base(&self) -> String {
        self.config.base_url.trim_end_matches('/').to_string()
    }

    fn endpoint(&self) -> Result<String, String> {
        let base = self.normalize_base();
        match self.config.protocol.as_str() {
            "OpenAI Compatible" => Ok(format!("{base}/chat/completions")),
            "Anthropic" => Ok(format!("{base}/messages")),
            "Gemini" => Ok(format!(
                "{base}/models/{}:generateContent",
                self.config.model
            )),
            "Ollama" => Ok(format!("{base}/api/chat")),
            other => Err(format!("Unsupported provider protocol: {other}")),
        }
    }

    fn payload(&self, request: &LlmRequest) -> Value {
        match self.config.protocol.as_str() {
            "OpenAI Compatible" => {
                let mut payload = json!({
                    "model": request.model,
                    "messages": [
                        {"role": "system", "content": request.system},
                        {"role": "user", "content": request.user}
                    ]
                });
                let new_token_parameter = request.model.starts_with("gpt-5")
                    || request.model.starts_with("o3")
                    || request.model.starts_with("o4");
                if new_token_parameter {
                    payload["max_completion_tokens"] = json!(request.max_tokens);
                } else {
                    payload["max_tokens"] = json!(request.max_tokens);
                    payload["temperature"] = json!(request.temperature);
                }
                if request.json_mode {
                    payload["response_format"] = json!({"type": "json_object"});
                }
                payload
            }
            "Anthropic" => json!({
                "model": request.model,
                "max_tokens": request.max_tokens,
                "temperature": request.temperature,
                "system": request.system,
                "messages": [{"role": "user", "content": request.user}]
            }),
            "Gemini" => json!({
                "systemInstruction": {
                    "parts": [{"text": request.system}]
                },
                "contents": [{
                    "role": "user",
                    "parts": [{"text": request.user}]
                }],
                "generationConfig": {
                    "temperature": request.temperature,
                    "maxOutputTokens": request.max_tokens,
                    "responseMimeType": if request.json_mode { "application/json" } else { "text/plain" }
                }
            }),
            "Ollama" => {
                let mut payload = json!({
                    "model": request.model,
                    "stream": false,
                    "messages": [
                        {"role": "system", "content": request.system},
                        {"role": "user", "content": request.user}
                    ],
                    "options": {
                        "temperature": request.temperature,
                        "num_predict": request.max_tokens
                    }
                });
                if request.json_mode {
                    payload["format"] = json!("json");
                }
                payload
            }
            _ => Value::Null,
        }
    }

    fn request_builder(&self, request: &LlmRequest) -> Result<reqwest::RequestBuilder, String> {
        let endpoint = self.endpoint()?;
        let builder = match self.config.protocol.as_str() {
            "OpenAI Compatible" => {
                let secret = self.secret.as_deref().ok_or_else(|| {
                    "API Key is missing for this OpenAI-compatible provider".to_string()
                })?;
                self.client
                    .post(endpoint)
                    .bearer_auth(secret)
                    .json(&self.payload(request))
            }
            "Anthropic" => {
                let secret = self
                    .secret
                    .as_deref()
                    .ok_or_else(|| "API Key is missing for Anthropic".to_string())?;
                self.client
                    .post(endpoint)
                    .header("x-api-key", secret)
                    .header("anthropic-version", "2023-06-01")
                    .json(&self.payload(request))
            }
            "Gemini" => {
                let secret = self
                    .secret
                    .as_deref()
                    .ok_or_else(|| "API Key is missing for Gemini".to_string())?;
                self.client
                    .post(format!(
                        "{}?key={}",
                        endpoint,
                        utf8_percent_encode(secret, NON_ALPHANUMERIC)
                    ))
                    .json(&self.payload(request))
            }
            "Ollama" => self.client.post(endpoint).json(&self.payload(request)),
            _ => return Err("Unsupported provider protocol".to_string()),
        };
        Ok(builder)
    }
}

#[async_trait]
impl LlmProvider for HttpLlmProvider {
    async fn complete(&self, request: LlmRequest) -> Result<LlmResponse, String> {
        let mut last_error = String::from("Provider request failed");
        for attempt in 0..3 {
            let response = self
                .request_builder(&request)?
                .send()
                .await
                .map_err(|error| format_provider_error(&error.to_string()))?;
            if response.status().is_success() {
                let status = response.status();
                let body: Value = response
                    .json()
                    .await
                    .map_err(|error| format!("Invalid JSON response ({status}): {error}"))?;
                return parse_response(&self.config.protocol, &request.model, &body);
            }

            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            last_error = format!(
                "Provider returned {}: {}",
                status,
                sanitize_error_body(&body)
            );
            if status != StatusCode::TOO_MANY_REQUESTS && !status.is_server_error() {
                return Err(last_error);
            }
            if attempt < 2 {
                tokio::time::sleep(Duration::from_millis(700 * (attempt + 1) as u64)).await;
            }
        }
        Err(last_error)
    }
}

fn parse_response(
    protocol: &str,
    requested_model: &str,
    body: &Value,
) -> Result<LlmResponse, String> {
    let (text, input_tokens, output_tokens, model) = match protocol {
        "OpenAI Compatible" => (
            body.pointer("/choices/0/message/content")
                .and_then(Value::as_str)
                .ok_or_else(|| "OpenAI response has no message content".to_string())?
                .to_string(),
            body.pointer("/usage/prompt_tokens").and_then(Value::as_u64),
            body.pointer("/usage/completion_tokens")
                .and_then(Value::as_u64),
            body.get("model")
                .and_then(Value::as_str)
                .unwrap_or(requested_model)
                .to_string(),
        ),
        "Anthropic" => {
            let text = body
                .get("content")
                .and_then(Value::as_array)
                .map(|parts| {
                    parts
                        .iter()
                        .filter_map(|part| part.get("text").and_then(Value::as_str))
                        .collect::<Vec<_>>()
                        .join("\n")
                })
                .unwrap_or_default();
            if text.is_empty() {
                return Err("Anthropic response has no text content".to_string());
            }
            (
                text,
                body.pointer("/usage/input_tokens").and_then(Value::as_u64),
                body.pointer("/usage/output_tokens").and_then(Value::as_u64),
                body.get("model")
                    .and_then(Value::as_str)
                    .unwrap_or(requested_model)
                    .to_string(),
            )
        }
        "Gemini" => {
            let text = body
                .pointer("/candidates/0/content/parts")
                .and_then(Value::as_array)
                .map(|parts| {
                    parts
                        .iter()
                        .filter_map(|part| part.get("text").and_then(Value::as_str))
                        .collect::<Vec<_>>()
                        .join("\n")
                })
                .unwrap_or_default();
            if text.is_empty() {
                return Err("Gemini response has no text content".to_string());
            }
            (
                text,
                body.pointer("/usageMetadata/promptTokenCount")
                    .and_then(Value::as_u64),
                body.pointer("/usageMetadata/candidatesTokenCount")
                    .and_then(Value::as_u64),
                requested_model.to_string(),
            )
        }
        "Ollama" => (
            body.pointer("/message/content")
                .and_then(Value::as_str)
                .ok_or_else(|| "Ollama response has no message content".to_string())?
                .to_string(),
            body.get("prompt_eval_count").and_then(Value::as_u64),
            body.get("eval_count").and_then(Value::as_u64),
            body.get("model")
                .and_then(Value::as_str)
                .unwrap_or(requested_model)
                .to_string(),
        ),
        other => return Err(format!("Unsupported protocol: {other}")),
    };
    Ok(LlmResponse {
        text,
        model,
        input_tokens,
        output_tokens,
    })
}

fn sanitize_error_body(body: &str) -> String {
    let message = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|value| {
            value
                .pointer("/error/message")
                .or_else(|| value.get("message"))
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_else(|| "Provider response error".to_string());
    redact_secret_tokens(&message).chars().take(300).collect()
}

fn format_provider_error(message: &str) -> String {
    if message.to_ascii_lowercase().contains("timeout") {
        "Provider request timed out".to_string()
    } else {
        "Provider network request failed".to_string()
    }
}

fn redact_secret_tokens(message: &str) -> String {
    message
        .split_whitespace()
        .map(|token| {
            let trimmed = token.trim_matches(|character: char| {
                matches!(character, '"' | '\'' | ',' | ';' | ')' | ']' | '}')
            });
            if trimmed.starts_with("sk-")
                || trimmed.starts_with("AIza")
                || trimmed.starts_with("xai-")
                || trimmed.starts_with("Bearer")
            {
                "[redacted]".to_string()
            } else {
                token.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

pub fn save_provider_secret(provider_id: &str, secret: &str) -> Result<(), String> {
    let entry = Entry::new(KEYRING_SERVICE, provider_id).map_err(|error| error.to_string())?;
    entry
        .set_password(secret)
        .map_err(|error| format!("Unable to save provider secret: {error}"))
}

pub fn clear_provider_secret(provider_id: &str) -> Result<(), String> {
    let entry = Entry::new(KEYRING_SERVICE, provider_id).map_err(|error| error.to_string())?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(_) => Ok(()),
    }
}

pub fn get_provider_secret(provider_id: &str) -> Option<String> {
    Entry::new(KEYRING_SERVICE, provider_id)
        .ok()
        .and_then(|entry| entry.get_password().ok())
}

pub async fn test_provider(config: ProviderConfig) -> Result<ProviderTestResult, String> {
    if !config.enabled {
        return Err("Provider is disabled".to_string());
    }
    if !config
        .capabilities
        .iter()
        .any(|capability| capability == "LLM")
    {
        let started = Instant::now();
        let client = Client::builder()
            .timeout(Duration::from_secs(30))
            .connect_timeout(Duration::from_secs(10))
            .user_agent("KnowMotion-AI-Studio/0.1")
            .build()
            .map_err(|error| error.to_string())?;
        let mut endpoint = if config.protocol == "ComfyUI" {
            format!("{}/system_stats", config.base_url.trim_end_matches('/'))
        } else {
            format!("{}/models", config.base_url.trim_end_matches('/'))
        };
        if config.protocol == "Gemini" {
            let secret = get_provider_secret(&config.id).ok_or_else(|| {
                format!("No API key is stored for provider {}", config.name)
            })?;
            endpoint = format!(
                "{}?key={}",
                endpoint,
                utf8_percent_encode(&secret, NON_ALPHANUMERIC)
            );
        }
        let mut request = client.get(endpoint);
        if config.protocol == "OpenAI Compatible" {
            let secret = get_provider_secret(&config.id).ok_or_else(|| {
                format!("No API key is stored for provider {}", config.name)
            })?;
            request = request.bearer_auth(secret);
        } else if config.protocol == "Anthropic" {
            let secret = get_provider_secret(&config.id).ok_or_else(|| {
                format!("No API key is stored for provider {}", config.name)
            })?;
            request = request
                .header("x-api-key", secret)
                .header("anthropic-version", "2023-06-01");
        }
        let response = request
            .send()
            .await
            .map_err(|error| format_provider_error(&error.to_string()))?;
        let status = response.status();
        if !status.is_success() {
            return Err(format!("Provider returned {status}"));
        }
        return Ok(ProviderTestResult {
            ok: true,
            message: "能力端点连接成功".to_string(),
            latency_ms: started.elapsed().as_millis(),
            model: config.model,
            backend: config.protocol,
        });
    }
    let provider = resolve_provider(&config, None).await?;
    let backend = provider
        .backend_label()
        .unwrap_or(&config.protocol)
        .to_string();
    let started = Instant::now();
    let response = provider
        .complete(LlmRequest {
            model: config.model.clone(),
            system: "You are a connection test. Return only JSON.".to_string(),
            user: "Return exactly {\"ok\":true}".to_string(),
            temperature: 0.0,
            max_tokens: 32,
            json_mode: true,
        })
        .await?;
    Ok(ProviderTestResult {
        ok: true,
        message: format!(
            "连接成功，返回：{}",
            response.text.chars().take(120).collect::<String>()
        ),
        latency_ms: started.elapsed().as_millis(),
        model: response.model,
        backend,
    })
}

pub async fn resolve_provider(
    provider: &ProviderConfig,
    model: Option<String>,
) -> Result<Box<dyn LlmProvider>, String> {
    if !provider.enabled {
        return Err(format!("Provider {} is disabled", provider.name));
    }
    let mut provider = provider.clone();
    if let Some(model) = model {
        if !model.trim().is_empty() {
            provider.model = model;
        }
    }
    if provider.protocol == "GGUF" {
        let local = tokio::task::spawn_blocking(move || GgufLlmProvider::load(&provider))
            .await
            .map_err(|error| format!("GGUF model loading task failed: {error}"))??;
        return Ok(Box::new(local));
    }
    let secret = if provider.protocol == "Ollama" || provider.protocol == "ComfyUI" {
        None
    } else {
        Some(
            get_provider_secret(&provider.id)
                .ok_or_else(|| format!("No API key is stored for provider {}", provider.name))?,
        )
    };
    Ok(Box::new(HttpLlmProvider::new(provider, secret)?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_openai_compatible_response() {
        let response = parse_response(
            "OpenAI Compatible",
            "gpt-test",
            &json!({
                "model": "gpt-test-2026",
                "choices": [{"message": {"content": "{\"ok\":true}"}}],
                "usage": {"prompt_tokens": 12, "completion_tokens": 5}
            }),
        )
        .expect("OpenAI response should parse");
        assert_eq!(response.text, "{\"ok\":true}");
        assert_eq!(response.input_tokens, Some(12));
        assert_eq!(response.output_tokens, Some(5));
    }

    #[test]
    fn parses_anthropic_content_parts() {
        let response = parse_response(
            "Anthropic",
            "claude-test",
            &json!({
                "model": "claude-test",
                "content": [{"type": "text", "text": "{\"ok\":true}"}],
                "usage": {"input_tokens": 8, "output_tokens": 4}
            }),
        )
        .expect("Anthropic response should parse");
        assert_eq!(response.text, "{\"ok\":true}");
        assert_eq!(response.output_tokens, Some(4));
    }

    #[test]
    fn provider_error_does_not_echo_raw_body() {
        let value = sanitize_error_body(
            r#"{"error":{"message":"invalid key sk-secret-value","code":"auth"}}"#,
        );
        assert!(value.contains("invalid key"));
        assert!(!value.contains("sk-secret-value"));
        assert!(!value.contains("{\"error\""));
    }

    #[test]
    fn provider_config_accepts_missing_context_size() {
        let config: ProviderConfig = serde_json::from_value(json!({
            "id": "local",
            "name": "Local GGUF",
            "protocol": "GGUF",
            "baseUrl": "C:\\models\\model.gguf",
            "model": "model.gguf",
            "enabled": true,
            "capabilities": ["LLM"]
        }))
        .expect("legacy provider config should deserialize");
        assert_eq!(config.context_size, None);
        assert_eq!(config.inference_backend, None);
    }
}
