use crate::{
    agent::get_provider_secret, logging, logging::LogLevel, safe_identifier,
    local_model_scheduler::{
        acquire_gpu, ensure_audio, ensure_diffusion, is_loopback_base_url, GpuLease,
        LocalRuntimeConfig, Workload,
    },
    public_url::{fetch_public_http, PublicHttpPolicy},
    storage::persist_generated_image,
    AppState,
};
use chrono::Utc;
use reqwest::Client;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    path::Path,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::State;
use uuid::Uuid;

const MAX_REFERENCE_IMAGE_BYTES: usize = 8 * 1024 * 1024;
const MAX_REFERENCE_IMAGES: usize = 3;
/// stable-diffusion.cpp 原生任务是异步的；轮询上限按大模型在消费级 GPU 上的耗时留足余量。
const SD_CPP_JOB_TIMEOUT: Duration = Duration::from_secs(900);
const SD_CPP_JOB_POLL_INTERVAL: Duration = Duration::from_millis(700);
const MAX_RESEARCH_SOURCE_BYTES: usize = 5 * 1024 * 1024;
const MAX_DOWNLOADED_IMAGE_BYTES: usize = 25 * 1024 * 1024;
const AUDIO_CPP_PROTOCOL: &str = "audio.cpp";
const STABLE_DIFFUSION_CPP_PROTOCOL: &str = "stable-diffusion.cpp";
const RESEARCH_CONTENT_TYPES: &[&str] = &[
    "text/html",
    "application/xhtml+xml",
    "text/plain",
];
const RESEARCH_HTTP_POLICY: PublicHttpPolicy = PublicHttpPolicy {
    max_bytes: MAX_RESEARCH_SOURCE_BYTES,
    max_redirects: 5,
    timeout: Duration::from_secs(20),
    allowed_content_types: RESEARCH_CONTENT_TYPES,
};
const IMAGE_HTTP_POLICY: PublicHttpPolicy = PublicHttpPolicy {
    max_bytes: MAX_DOWNLOADED_IMAGE_BYTES,
    max_redirects: 5,
    timeout: Duration::from_secs(60),
    allowed_content_types: &[],
};

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageProviderConfig {
    pub id: String,
    pub name: String,
    pub protocol: String,
    pub base_url: String,
    pub model: String,
    #[serde(default)]
    pub inference_backend: Option<String>,
    #[serde(default)]
    pub runtime: Option<LocalRuntimeConfig>,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub capabilities: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ImageReferenceInput {
    #[serde(default)]
    pub asset_id: String,
    #[serde(default)]
    pub role: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub weight: f32,
    /// 项目内 kmasset URL 或 data URL；不接受任意外部 URL。
    #[serde(default)]
    pub source: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ImageConditioningInput {
    /// prompt | img2img-reference | ip-adapter | controlnet
    #[serde(default)]
    pub mode: String,
    /// 0–1：img2img 去噪强度 / ControlNet 与 IP-Adapter 强度。
    #[serde(default)]
    pub strength: f32,
    #[serde(default)]
    pub reference_asset_id: String,
    #[serde(default)]
    pub control_type: String,
    #[serde(default)]
    pub start_at: f32,
    #[serde(default)]
    pub end_at: f32,
    #[serde(default)]
    pub lock_count: usize,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageGenerationRequest {
    pub project_id: String,
    pub scene_id: String,
    pub provider: ImageProviderConfig,
    pub prompt: String,
    pub style: String,
    pub size: String,
    pub count: u8,
    #[serde(default)]
    pub negative_prompt: String,
    #[serde(default)]
    pub seed: Option<i64>,
    #[serde(default)]
    pub references: Vec<ImageReferenceInput>,
    #[serde(default)]
    pub anchor_label: String,
    #[serde(default)]
    pub consistency_fingerprint: String,
    #[serde(default)]
    pub conditioning: Option<ImageConditioningInput>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageGenerationResult {
    pub assets: Vec<Value>,
    pub provider_id: String,
    pub model: String,
    pub elapsed_ms: u128,
    pub reference_mode: String,
    pub reference_count: usize,
    pub seed: i64,
    pub anchor_label: String,
    /// 实际生效的像素条件通道。
    pub conditioning: String,
    /// 前端请求的条件通道。
    pub requested_conditioning: String,
    /// 降级或其他需要注意的原因。
    pub degradations: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TtsScene {
    pub id: String,
    pub title: String,
    pub narration: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TtsGenerationRequest {
    pub project_id: String,
    pub provider: ImageProviderConfig,
    pub scenes: Vec<TtsScene>,
    pub voice: String,
    pub rate: f32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TtsGenerationResult {
    pub assets: Vec<Value>,
    pub provider_id: String,
    pub model: String,
    pub elapsed_ms: u128,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AsrRequest {
    pub project_id: String,
    pub asset_id: String,
    pub provider: ImageProviderConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AsrCue {
    pub start: f64,
    pub end: f64,
    pub text: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AsrResult {
    pub text: String,
    pub cues: Vec<AsrCue>,
    pub provider_id: String,
    pub model: String,
    pub elapsed_ms: u128,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddingRequest {
    pub project_id: String,
    pub source_id: String,
    pub texts: Vec<String>,
    pub provider: ImageProviderConfig,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddingResult {
    pub chunks: usize,
    pub dimensions: usize,
    pub provider_id: String,
    pub model: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeSearchRequest {
    pub project_id: String,
    pub query: String,
    pub limit: Option<usize>,
    pub provider: ImageProviderConfig,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeSearchResult {
    pub source_id: String,
    pub chunk_index: i64,
    pub text: String,
    pub score: f64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResearchFetchRequest {
    pub url: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResearchFetchResult {
    pub title: String,
    pub text: String,
    pub url: String,
    pub bytes: usize,
}

#[tauri::command]
pub async fn transcribe_project_audio(
    state: State<'_, AppState>,
    request: AsrRequest,
) -> Result<AsrResult, String> {
    if !safe_identifier(&request.project_id) || !safe_identifier(&request.asset_id) {
        return Err("Invalid ASR request identifiers".to_string());
    }
    if !matches!(
        request.provider.protocol.as_str(),
        "OpenAI Compatible" | AUDIO_CPP_PROTOCOL
    ) || !request
        .provider
        .capabilities
        .iter()
        .any(|capability| capability == "ASR")
    {
        return Err("ASR requires an OpenAI Compatible or audio.cpp provider".to_string());
    }
    let uses_audio_cpp = request.provider.protocol == AUDIO_CPP_PROTOCOL;
    let _local_lease = if uses_audio_cpp && is_loopback_base_url(&request.provider.base_url) {
        let lease = acquire_gpu(
            Workload::Audio,
            &request.provider.id,
            &request.provider.base_url,
            request.provider.runtime.as_ref(),
            request.provider.inference_backend.as_deref(),
        )
        .await?;
        ensure_audio(
            &request.provider.id,
            &request.provider.base_url,
            &request.provider.model,
            "ASR",
            request.provider.runtime.as_ref(),
            request.provider.inference_backend.as_deref(),
        )
        .await?;
        Some(lease)
    } else {
        None
    };
    let secret = if uses_audio_cpp {
        None
    } else {
        Some(
            get_provider_secret(&request.provider.id)
                .ok_or_else(|| "No API key is stored for the ASR provider".to_string())?,
        )
    };
    let project_root = state.projects_root.join(&request.project_id);
    let project: Value = serde_json::from_str(
        &std::fs::read_to_string(project_root.join("project.json"))
            .map_err(|error| format!("Project manifest is unavailable: {error}"))?,
    )
    .map_err(|error| format!("Project manifest is invalid: {error}"))?;
    let source = project
        .get("assets")
        .and_then(Value::as_array)
        .and_then(|assets| {
            assets
                .iter()
                .find(|asset| asset.get("id").and_then(Value::as_str) == Some(&request.asset_id))
        })
        .and_then(|asset| asset.get("src"))
        .and_then(Value::as_str)
        .ok_or_else(|| "ASR source asset was not found in the project manifest".to_string())?;
    let relative = crate::storage::client_url_to_relative(&request.project_id, source)
        .unwrap_or_else(|| source.to_string());
    let relative = crate::storage::safe_relative_path(&relative)
        .ok_or_else(|| "ASR source path is unsafe".to_string())?;
    let audio_path = project_root.join(&relative);
    let audio =
        std::fs::read(&audio_path).map_err(|error| format!("Unable to read ASR audio: {error}"))?;
    if audio.is_empty() || audio.len() > 25 * 1024 * 1024 {
        return Err("ASR audio must be between 1 byte and 25 MB".to_string());
    }
    let filename = audio_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("audio.wav");
    let started = Instant::now();
    let (text, cues) = transcribe_audio(&request.provider, secret.as_deref(), filename, &audio).await?;
    logging::log_event(
        LogLevel::Info,
        "provider.asr",
        "Audio transcription completed",
        Some(json!({
            "projectId": request.project_id,
            "assetId": request.asset_id,
            "providerId": request.provider.id,
            "model": request.provider.model,
            "protocol": request.provider.protocol,
            "segments": cues.len(),
            "elapsedMs": started.elapsed().as_millis()
        })),
    );
    Ok(AsrResult {
        text,
        cues,
        provider_id: request.provider.id,
        model: request.provider.model,
        elapsed_ms: started.elapsed().as_millis(),
    })
}

#[tauri::command]
pub async fn embed_project_knowledge(
    state: State<'_, AppState>,
    request: EmbeddingRequest,
) -> Result<EmbeddingResult, String> {
    if !safe_identifier(&request.project_id) {
        return Err("Invalid project id".to_string());
    }
    if request.provider.protocol != "OpenAI Compatible"
        || !request
            .provider
            .capabilities
            .iter()
            .any(|capability| capability == "Embedding")
    {
        return Err("Embedding requires an enabled OpenAI-compatible provider".to_string());
    }
    let chunks = chunk_knowledge(&request.texts);
    if chunks.is_empty() || chunks.len() > 500 {
        return Err("Knowledge source must produce between 1 and 500 chunks".to_string());
    }
    let embeddings = request_embeddings(&request.provider, &chunks).await?;
    let dimensions = embeddings.first().map(Vec::len).unwrap_or(0);
    if dimensions == 0
        || embeddings
            .iter()
            .any(|embedding| embedding.len() != dimensions)
    {
        return Err("Embedding provider returned inconsistent vector dimensions".to_string());
    }
    let now = Utc::now().to_rfc3339();
    let mut database = state
        .database
        .lock()
        .map_err(|_| "Database lock is unavailable".to_string())?;
    let transaction = database.transaction().map_err(|error| error.to_string())?;
    transaction
        .execute(
            "DELETE FROM knowledge_chunks WHERE project_id = ?1 AND source_id = ?2",
            rusqlite::params![request.project_id, request.source_id],
        )
        .map_err(|error| error.to_string())?;
    for (index, (text, embedding)) in chunks.iter().zip(embeddings.iter()).enumerate() {
        transaction
            .execute(
                r#"
                INSERT INTO knowledge_chunks(
                    id, project_id, source_id, chunk_index, text,
                    embedding_json, created_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                "#,
                rusqlite::params![
                    Uuid::new_v4().to_string(),
                    request.project_id,
                    request.source_id,
                    index as i64,
                    text,
                    serde_json::to_string(embedding).map_err(|error| error.to_string())?,
                    now
                ],
            )
            .map_err(|error| error.to_string())?;
    }
    transaction.commit().map_err(|error| error.to_string())?;
    logging::log_event(
        LogLevel::Info,
        "knowledge",
        "Knowledge source embedded",
        Some(json!({
            "projectId": request.project_id,
            "sourceId": request.source_id,
            "providerId": request.provider.id,
            "chunks": chunks.len(),
            "dimensions": dimensions
        })),
    );
    Ok(EmbeddingResult {
        chunks: chunks.len(),
        dimensions,
        provider_id: request.provider.id,
        model: request.provider.model,
    })
}

#[tauri::command]
pub async fn search_project_knowledge(
    state: State<'_, AppState>,
    request: KnowledgeSearchRequest,
) -> Result<Vec<KnowledgeSearchResult>, String> {
    if request.query.trim().is_empty() {
        return Err("Knowledge query cannot be empty".to_string());
    }
    let query_embedding = request_embeddings(&request.provider, &[request.query])
        .await?
        .into_iter()
        .next()
        .ok_or_else(|| "Embedding provider returned no query vector".to_string())?;
    let records = {
        let database = state
            .database
            .lock()
            .map_err(|_| "Database lock is unavailable".to_string())?;
        let mut statement = database
            .prepare(
                r#"
                SELECT source_id, chunk_index, text, embedding_json
                FROM knowledge_chunks WHERE project_id = ?1
                "#,
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(rusqlite::params![request.project_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        rows
    };
    let mut results = records
        .into_iter()
        .filter_map(|(source_id, chunk_index, text, embedding_json)| {
            let embedding: Vec<f32> = serde_json::from_str(&embedding_json).ok()?;
            let score = cosine_similarity(&query_embedding, &embedding)?;
            Some(KnowledgeSearchResult {
                source_id,
                chunk_index,
                text,
                score,
            })
        })
        .collect::<Vec<_>>();
    results.sort_by(|left, right| {
        right
            .score
            .partial_cmp(&left.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    results.truncate(request.limit.unwrap_or(8).clamp(1, 30));
    logging::log_event(
        LogLevel::Debug,
        "knowledge",
        "Knowledge search completed",
        Some(json!({
            "projectId": request.project_id,
            "results": results.len()
        })),
    );
    Ok(results)
}

#[tauri::command]
pub async fn fetch_research_source(
    request: ResearchFetchRequest,
) -> Result<ResearchFetchResult, String> {
    let fetched = tokio::time::timeout(
        Duration::from_secs(60),
        fetch_public_http(&request.url, RESEARCH_HTTP_POLICY),
    )
    .await
    .map_err(|_| "Research source request timed out".to_string())?
    .map_err(|error| format!("Research source rejected: {error}"))?;
    let url = fetched.final_url;
    let bytes = fetched.bytes;
    let html = String::from_utf8_lossy(&bytes);
    let title = extract_tag_text(&html, "title")
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| url.to_string());
    let text = html_to_text(&html);
    if text.trim().len() < 80 {
        return Err("Research source did not contain enough extractable text".to_string());
    }
    logging::log_event(
        LogLevel::Info,
        "research",
        "Research source fetched",
        Some(json!({
            "host": url.host_str(),
            "bytes": bytes.len(),
            "extractedCharacters": text.chars().count(),
            "redirects": fetched.redirects
        })),
    );
    Ok(ResearchFetchResult {
        title,
        text: text.chars().take(120_000).collect(),
        url: url.to_string(),
        bytes: bytes.len(),
    })
}

#[tauri::command]
pub async fn generate_project_cloud_narration(
    state: State<'_, AppState>,
    request: TtsGenerationRequest,
) -> Result<TtsGenerationResult, String> {
    if !safe_identifier(&request.project_id) {
        return Err("Invalid project id".to_string());
    }
    if !request.provider.enabled
        || !request
            .provider
            .capabilities
            .iter()
            .any(|capability| capability == "TTS")
    {
        return Err("The selected provider is not an enabled TTS provider".to_string());
    }
    if !matches!(
        request.provider.protocol.as_str(),
        "OpenAI Compatible" | AUDIO_CPP_PROTOCOL
    ) {
        return Err("TTS requires an OpenAI Compatible or audio.cpp speech endpoint".to_string());
    }
    if request.scenes.is_empty() || request.scenes.len() > 100 {
        return Err("TTS request must contain between 1 and 100 scenes".to_string());
    }
    let uses_audio_cpp = request.provider.protocol == AUDIO_CPP_PROTOCOL;
    let _local_lease = if uses_audio_cpp && is_loopback_base_url(&request.provider.base_url) {
        let lease = acquire_gpu(
            Workload::Audio,
            &request.provider.id,
            &request.provider.base_url,
            request.provider.runtime.as_ref(),
            request.provider.inference_backend.as_deref(),
        )
        .await?;
        ensure_audio(
            &request.provider.id,
            &request.provider.base_url,
            &request.provider.model,
            "TTS",
            request.provider.runtime.as_ref(),
            request.provider.inference_backend.as_deref(),
        )
        .await?;
        Some(lease)
    } else {
        None
    };
    let secret = if uses_audio_cpp {
        None
    } else {
        Some(
            get_provider_secret(&request.provider.id)
                .ok_or_else(|| "No API key is stored for the TTS provider".to_string())?,
        )
    };
    let started = Instant::now();
    let mut assets = Vec::new();
    let mut total_audio_ms = 0_i64;
    for scene in &request.scenes {
        if scene.narration.trim().is_empty() {
            continue;
        }
        let bytes = synthesize_speech(
            &request.provider,
            secret.as_deref(),
            &scene.narration,
            &request.voice,
            request.rate,
        )
        .await?;
        let duration_ms = wav_duration_ms(&bytes)?;
        let asset_id = format!("asset_{}", Uuid::new_v4().simple());
        let (relative, mime_type, _sha256) = crate::storage::persist_generated_audio(
            &state.projects_root,
            &request.project_id,
            &asset_id,
            &bytes,
            "audio/wav",
        )?;
        total_audio_ms += duration_ms;
        assets.push(json!({
            "id": asset_id,
            "sceneId": scene.id,
            "name": format!("{} · 云端旁白", scene.title),
            "kind": "audio",
            "src": crate::storage::public_asset_source(&request.project_id, &relative),
            "prompt": scene.narration,
            "createdAt": Utc::now().to_rfc3339(),
            "local": false,
            "durationMs": duration_ms,
            "mimeType": mime_type,
            "providerId": request.provider.id,
        }));
    }
    if assets.is_empty() {
        return Err("No narration scenes contained text".to_string());
    }
    if let Ok(database) = state.database.lock() {
        let _ = database.execute(
            r#"
            INSERT INTO usage_records(
                id, project_id, capability, audio_ms, estimated_cost_micros,
                currency, created_at
            ) VALUES (?1, ?2, 'TTS', ?3, 0, 'USD', ?4)
            "#,
            rusqlite::params![
                Uuid::new_v4().to_string(),
                request.project_id,
                total_audio_ms,
                Utc::now().to_rfc3339()
            ],
        );
    }
    logging::log_event(
        LogLevel::Info,
        "provider.tts",
        "Cloud narration completed",
        Some(json!({
            "projectId": request.project_id,
            "providerId": request.provider.id,
            "model": request.provider.model,
            "protocol": request.provider.protocol,
            "scenes": assets.len(),
            "audioMs": total_audio_ms,
            "elapsedMs": started.elapsed().as_millis()
        })),
    );
    Ok(TtsGenerationResult {
        assets,
        provider_id: request.provider.id,
        model: request.provider.model,
        elapsed_ms: started.elapsed().as_millis(),
    })
}

/// TTS 传输核心：向音频服务请求一段旁白并返回 WAV 字节。
///
/// 命令层与真实服务验收共用这一实现，避免验收路径和生产路径分叉。
pub(crate) async fn synthesize_speech(
    provider: &ImageProviderConfig,
    secret: Option<&str>,
    text: &str,
    voice: &str,
    rate: f32,
) -> Result<Vec<u8>, String> {
    let uses_audio_cpp = provider.protocol == AUDIO_CPP_PROTOCOL;
    let endpoint = format!(
        "{}{}/audio/speech",
        provider.base_url.trim_end_matches('/'),
        if uses_audio_cpp { "/v1" } else { "" }
    );
    let mut payload = json!({
        "model": provider.model,
        "input": text,
        "voice": if voice.trim().is_empty() {
            if uses_audio_cpp { "serena" } else { "alloy" }
        } else {
            voice.trim()
        }
    });
    if !uses_audio_cpp {
        payload["response_format"] = json!("wav");
        payload["speed"] = json!(rate.clamp(0.5, 2.0));
    }
    let mut http_request = http_client()?.post(&endpoint).json(&payload);
    if let Some(secret) = secret {
        http_request = http_request.bearer_auth(secret);
    }
    let response = http_request.send().await.map_err(provider_network_error)?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("TTS provider returned {status}"));
    }
    Ok(response
        .bytes()
        .await
        .map_err(provider_network_error)?
        .to_vec())
}

pub(crate) fn wav_duration_ms(bytes: &[u8]) -> Result<i64, String> {
    let reader = hound::WavReader::new(std::io::Cursor::new(bytes))
        .map_err(|error| format!("TTS response is not a valid WAV file: {error}"))?;
    let spec = reader.spec();
    let duration_ms = (reader.duration() as f64 / spec.sample_rate as f64 * 1000.0).round() as i64;
    if duration_ms <= 0 {
        return Err("TTS response WAV has no audio samples".to_string());
    }
    Ok(duration_ms)
}

/// ASR 传输核心：multipart 上传音频并解析文本与时间片段。
///
/// 命令层与真实服务验收共用这一实现。
pub(crate) async fn transcribe_audio(
    provider: &ImageProviderConfig,
    secret: Option<&str>,
    filename: &str,
    audio: &[u8],
) -> Result<(String, Vec<AsrCue>), String> {
    let uses_audio_cpp = provider.protocol == AUDIO_CPP_PROTOCOL;
    let content_type = if audio.starts_with(b"RIFF") {
        "audio/wav"
    } else {
        "audio/mpeg"
    };
    let boundary = format!("knowmotion-{}", Uuid::new_v4().simple());
    let mut body = Vec::new();
    append_multipart_field(&mut body, &boundary, "model", &provider.model);
    if !uses_audio_cpp {
        append_multipart_field(&mut body, &boundary, "response_format", "verbose_json");
    }
    append_multipart_file(&mut body, &boundary, "file", filename, content_type, audio);
    body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
    let endpoint = if uses_audio_cpp {
        format!(
            "{}/v1/audio/transcriptions/details",
            provider.base_url.trim_end_matches('/')
        )
    } else {
        format!(
            "{}/audio/transcriptions",
            provider.base_url.trim_end_matches('/')
        )
    };
    let mut http_request = http_client()?
        .post(endpoint)
        .header(
            reqwest::header::CONTENT_TYPE,
            format!("multipart/form-data; boundary={boundary}"),
        )
        .body(body);
    if let Some(secret) = secret {
        http_request = http_request.bearer_auth(secret);
    }
    let response = http_request.send().await.map_err(provider_network_error)?;
    let status = response.status();
    let payload: Value = response
        .json()
        .await
        .map_err(|_| format!("ASR provider returned non-JSON response ({status})"))?;
    if !status.is_success() {
        return Err(format!("ASR provider returned {status}"));
    }
    let text = payload
        .get("text")
        .and_then(Value::as_str)
        .ok_or_else(|| "ASR response has no text".to_string())?
        .to_string();
    Ok((text, parse_asr_cues(&payload)))
}

fn parse_asr_cues(payload: &Value) -> Vec<AsrCue> {
    let direct = payload
        .get("segments")
        .and_then(Value::as_array)
        .map(|segments| {
            segments
                .iter()
                .filter_map(|segment| {
                    Some(AsrCue {
                        start: segment.get("start")?.as_f64()?,
                        end: segment.get("end")?.as_f64()?,
                        text: segment.get("text")?.as_str()?.trim().to_string(),
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if !direct.is_empty() {
        return direct;
    }

    let Some(sample_rate) = payload
        .get("sample_rate")
        .and_then(Value::as_f64)
        .filter(|rate| *rate > 0.0)
    else {
        return Vec::new();
    };
    payload
        .get("segments")
        .and_then(Value::as_array)
        .map(|segments| {
            segments
                .iter()
                .filter_map(|segment| {
                    Some(AsrCue {
                        start: segment.get("start_sample")?.as_f64()? / sample_rate,
                        end: segment.get("end_sample")?.as_f64()? / sample_rate,
                        text: segment.get("text")?.as_str()?.trim().to_string(),
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

fn optional_provider_secret(provider: &ImageProviderConfig) -> Result<Option<String>, String> {
    if provider.protocol == "OpenAI Compatible" {
        return get_provider_secret(&provider.id)
            .map(Some)
            .ok_or_else(|| "No API key is stored for the image provider".to_string());
    }
    Ok(None)
}

async fn prepare_local_diffusion(
    provider: &ImageProviderConfig,
) -> Result<Option<GpuLease>, String> {
    if provider.protocol != STABLE_DIFFUSION_CPP_PROTOCOL
        || !is_loopback_base_url(&provider.base_url)
    {
        return Ok(None);
    }
    let lease = acquire_gpu(
        Workload::Diffusion,
        &provider.id,
        &provider.base_url,
        provider.runtime.as_ref(),
        provider.inference_backend.as_deref(),
    )
    .await?;
    ensure_diffusion(
        &provider.id,
        &provider.base_url,
        provider.runtime.as_ref(),
        provider.inference_backend.as_deref(),
    )
    .await?;
    Ok(Some(lease))
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InpaintRequest {
    pub project_id: String,
    pub scene_id: String,
    pub source_asset_id: String,
    pub provider: ImageProviderConfig,
    pub prompt: String,
    pub size: String,
    /// 透明=重绘的遮罩，供 OpenAI images/edits 使用。
    pub mask_alpha_data_url: String,
    #[serde(default)]
    pub mask_coverage: f32,
    #[serde(default)]
    pub seed: Option<i64>,
    #[serde(default)]
    pub anchor_label: String,
    #[serde(default)]
    pub consistency_fingerprint: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InpaintResult {
    pub asset: Value,
    pub provider_id: String,
    pub model: String,
    pub elapsed_ms: u128,
    pub mode: String,
    pub seed: i64,
}

#[tauri::command]
pub async fn generate_project_images(
    state: State<'_, AppState>,
    request: ImageGenerationRequest,
) -> Result<ImageGenerationResult, String> {
    execute_image_generation(&state.projects_root, &state.database, request).await
}

/// 队列 worker 与单次命令共用的生成入口：校验、Provider 调用、落盘、
/// 用量记录和结构化日志都在这里完成。
pub(crate) async fn execute_image_generation(
    projects_root: &Path,
    database: &Arc<Mutex<Connection>>,
    request: ImageGenerationRequest,
) -> Result<ImageGenerationResult, String> {
    if !safe_identifier(&request.project_id) || !safe_identifier(&request.scene_id) {
        return Err("Invalid project or scene id".to_string());
    }
    if !request.provider.enabled {
        return Err("The selected image provider is disabled".to_string());
    }
    if !request
        .provider
        .capabilities
        .iter()
        .any(|capability| capability == "Image")
    {
        return Err("The selected provider does not declare Image capability".to_string());
    }
    if request.prompt.trim().is_empty() {
        return Err("Image prompt cannot be empty".to_string());
    }
    let count = request.count.clamp(1, 4);
    let prompt = if request.style.trim().is_empty() {
        request.prompt.trim().to_string()
    } else {
        format!(
            "{}. Visual direction: {}",
            request.prompt.trim(),
            request.style.trim()
        )
    };
    let seed = request
        .seed
        .unwrap_or_else(|| (Utc::now().timestamp_millis() as i64).rem_euclid(2_000_000_000));
    let mut reference_images: Vec<(&ImageReferenceInput, Vec<u8>)> = Vec::new();
    for reference in request.references.iter().take(MAX_REFERENCE_IMAGES) {
        match read_reference_bytes(projects_root, &request.project_id, &reference.source) {
            Ok(bytes) => match detect_image_mime(&bytes) {
                Ok(_) => reference_images.push((reference, bytes)),
                Err(error) => logging::log_event(
                    LogLevel::Warn,
                    "provider.image.reference",
                    "Reference image rejected by signature check",
                    Some(json!({
                        "projectId": request.project_id,
                        "assetId": reference.asset_id,
                        "error": limit(&error)
                    })),
                ),
            },
            Err(error) => logging::log_event(
                LogLevel::Warn,
                "provider.image.reference",
                "Reference image could not be resolved",
                Some(json!({
                    "projectId": request.project_id,
                    "assetId": reference.asset_id,
                    "error": limit(&error)
                })),
            ),
        }
    }

    let plan = plan_conditioning(
        &request.provider.protocol,
        request.conditioning.as_ref(),
        &reference_images,
    );

    let started = Instant::now();
    let (images, reference_mode, transport_degradations) = generate_images_with_conditioning(
        &request.provider,
        &prompt,
        &request.negative_prompt,
        &request.size,
        count,
        seed,
        &plan,
    )
    .await?;
    let mut degradations = plan.degradations.clone();
    degradations.extend(transport_degradations);

    let reference_ids = reference_images
        .iter()
        .map(|(input, _)| input.asset_id.clone())
        .collect::<Vec<_>>();
    // 把锚点快照写进每个素材，批量队列产出的结果在重新打开应用后仍可判定是否过期。
    let consistency = if request.consistency_fingerprint.is_empty() {
        Value::Null
    } else {
        json!({
            "fingerprint": request.consistency_fingerprint,
            "anchorLabel": request.anchor_label,
            "seed": seed,
            "prompt": prompt,
            "negativePrompt": request.negative_prompt,
            "referenceAssetIds": reference_ids,
            "conditioning": reference_mode,
            "requestedConditioning": plan.requested.clone(),
            "degradations": degradations.clone(),
            "lockCount": plan.lock_count,
            "generatedAt": Utc::now().to_rfc3339()
        })
    };
    let mut assets = Vec::new();
    for (index, bytes) in images.into_iter().enumerate() {
        let asset_id = format!("asset_{}", Uuid::new_v4().simple());
        let mime_type = detect_image_mime(&bytes)?;
        let (relative, mime_type, _sha256) = persist_generated_image(
            projects_root,
            &request.project_id,
            &asset_id,
            &bytes,
            mime_type,
        )?;
        let mut asset = json!({
            "id": asset_id,
            "sceneId": request.scene_id,
            "name": format!("AI 视觉 {} · {}", index + 1, request.provider.name),
            "kind": "image",
            "src": crate::storage::public_asset_source(&request.project_id, &relative),
            "prompt": prompt,
            "createdAt": Utc::now().to_rfc3339(),
            "local": false,
            "mimeType": mime_type,
            "providerId": request.provider.id,
        });
        if consistency != Value::Null {
            asset["consistency"] = consistency.clone();
        }
        assets.push(asset);
    }

    if let Ok(database) = database.lock() {
        let _ = database.execute(
            r#"
            INSERT INTO usage_records(
                id, project_id, capability, image_count, estimated_cost_micros,
                currency, created_at
            ) VALUES (?1, ?2, 'Image', ?3, 0, 'USD', ?4)
            "#,
            rusqlite::params![
                Uuid::new_v4().to_string(),
                request.project_id,
                assets.len() as i64,
                Utc::now().to_rfc3339()
            ],
        );
    }

    logging::log_event(
        LogLevel::Info,
        "provider.image",
        "Image generation completed",
        Some(json!({
            "projectId": request.project_id,
            "sceneId": request.scene_id,
            "providerId": request.provider.id,
            "model": request.provider.model,
            "images": assets.len(),
            "elapsedMs": started.elapsed().as_millis(),
            "seed": seed,
            "references": reference_images.len(),
            "referenceDetails": reference_images
                .iter()
                .map(|(input, _)| json!({
                    "assetId": input.asset_id,
                    "role": input.role,
                    "label": input.label,
                    "weight": input.weight
                }))
                .collect::<Vec<_>>(),
            "referenceMode": reference_mode,
            "requestedConditioning": plan.requested,
            "degradations": degradations,
            "lockCount": plan.lock_count,
            "anchorLabel": request.anchor_label,
            "fingerprint": request.consistency_fingerprint
        })),
    );
    Ok(ImageGenerationResult {
        assets,
        provider_id: request.provider.id,
        model: request.provider.model,
        elapsed_ms: started.elapsed().as_millis(),
        reference_mode: reference_mode.to_string(),
        reference_count: reference_images.len(),
        seed,
        anchor_label: request.anchor_label,
        conditioning: reference_mode.to_string(),
        requested_conditioning: plan.requested,
        degradations,
    })
}

/// 把设定集参考图解析成本地字节。只接受项目内素材或 data URL，
/// 避免把生成请求变成任意文件/网络读取通道。
fn read_reference_bytes(
    projects_root: &Path,
    project_id: &str,
    source: &str,
) -> Result<Vec<u8>, String> {
    if let Some(data_url) = source.strip_prefix("data:") {
        let (header, encoded) = data_url
            .split_once(',')
            .ok_or_else(|| "Reference image contains a malformed data URL".to_string())?;
        if !header.ends_with(";base64") {
            return Err("Reference image must be base64 encoded".to_string());
        }
        use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
        let bytes = BASE64
            .decode(encoded)
            .map_err(|error| format!("Invalid reference image base64: {error}"))?;
        if bytes.len() > MAX_REFERENCE_IMAGE_BYTES {
            return Err("Reference image exceeds the 8 MiB limit".to_string());
        }
        return Ok(bytes);
    }
    let relative = crate::storage::client_url_to_relative(project_id, source)
        .or_else(|| crate::storage::safe_relative_path(source))
        .ok_or_else(|| "Reference image must be a project asset".to_string())?;
    let path = projects_root.join(project_id).join(&relative);
    let metadata = std::fs::metadata(&path)
        .map_err(|error| format!("Reference image is unavailable: {error}"))?;
    if metadata.len() as usize > MAX_REFERENCE_IMAGE_BYTES {
        return Err("Reference image exceeds the 8 MiB limit".to_string());
    }
    std::fs::read(&path).map_err(|error| format!("Unable to read reference image: {error}"))
}

#[tauri::command]
pub async fn inpaint_project_image(
    state: State<'_, AppState>,
    request: InpaintRequest,
) -> Result<InpaintResult, String> {
    if !safe_identifier(&request.project_id)
        || !safe_identifier(&request.scene_id)
        || !safe_identifier(&request.source_asset_id)
    {
        return Err("Invalid inpaint request identifiers".to_string());
    }
    if !request.provider.enabled {
        return Err("The selected image provider is disabled".to_string());
    }
    if !request
        .provider
        .capabilities
        .iter()
        .any(|capability| capability == "Image")
    {
        return Err("The selected provider does not declare Image capability".to_string());
    }
    if request.prompt.trim().is_empty() {
        return Err("Inpaint prompt cannot be empty".to_string());
    }
    let (source_bytes, source_mime) = read_project_asset_image(
        &state.projects_root,
        &request.project_id,
        &request.source_asset_id,
    )?;
    let seed = request
        .seed
        .unwrap_or_else(|| (Utc::now().timestamp_millis() as i64).rem_euclid(2_000_000_000));
    let _local_lease = prepare_local_diffusion(&request.provider).await?;
    let started = Instant::now();
    let (bytes, mode) = match request.provider.protocol.as_str() {
        "OpenAI Compatible" | STABLE_DIFFUSION_CPP_PROTOCOL => {
            let alpha_mask = decode_png_data_url(&request.mask_alpha_data_url, "alpha mask")?;
            (
                generate_openai_inpaint(
                    &request.provider,
                    request.prompt.trim(),
                    &request.size,
                    &source_bytes,
                    source_mime,
                    &alpha_mask,
                )
                .await?,
                "openai-edits",
            )
        }
        other => {
            return Err(format!(
                "Provider protocol {other} does not implement image inpainting"
            ))
        }
    };

    let asset_id = format!("asset_{}", Uuid::new_v4().simple());
    let mime_type = detect_image_mime(&bytes)?;
    let (relative, mime_type, _sha256) = persist_generated_image(
        &state.projects_root,
        &request.project_id,
        &asset_id,
        &bytes,
        mime_type,
    )?;
    let asset = json!({
        "id": asset_id,
        "sceneId": request.scene_id,
        "name": format!("局部重绘 · {}", request.provider.name),
        "kind": "image",
        "src": crate::storage::public_asset_source(&request.project_id, &relative),
        "prompt": request.prompt,
        "createdAt": Utc::now().to_rfc3339(),
        "local": false,
        "mimeType": mime_type,
        "providerId": request.provider.id,
        "inpaint": {
            "sourceAssetId": request.source_asset_id,
            "mode": mode,
            "coverage": request.mask_coverage.clamp(0.0, 1.0),
            "seed": seed,
            "anchorLabel": request.anchor_label,
            "fingerprint": request.consistency_fingerprint
        }
    });
    if let Ok(database) = state.database.lock() {
        let _ = database.execute(
            r#"
            INSERT INTO usage_records(
                id, project_id, capability, image_count, estimated_cost_micros,
                currency, created_at
            ) VALUES (?1, ?2, 'ImageEdit', 1, 0, 'USD', ?3)
            "#,
            rusqlite::params![
                Uuid::new_v4().to_string(),
                request.project_id,
                Utc::now().to_rfc3339()
            ],
        );
    }
    logging::log_event(
        LogLevel::Info,
        "provider.image",
        "Image inpaint completed",
        Some(json!({
            "projectId": request.project_id,
            "sourceAssetId": request.source_asset_id,
            "providerId": request.provider.id,
            "mode": mode,
            "seed": seed,
            "coverage": request.mask_coverage,
            "elapsedMs": started.elapsed().as_millis()
        })),
    );
    Ok(InpaintResult {
        asset,
        provider_id: request.provider.id,
        model: request.provider.model,
        elapsed_ms: started.elapsed().as_millis(),
        mode: mode.to_string(),
        seed,
    })
}

/// 读取项目内某张图片素材的本地字节。只接受项目目录内登记的素材，
/// 保证重绘不会变成任意外部读取入口。
fn read_project_asset_image(
    projects_root: &Path,
    project_id: &str,
    asset_id: &str,
) -> Result<(Vec<u8>, &'static str), String> {
    let project_root = projects_root.join(project_id);
    let project: Value = serde_json::from_str(
        &std::fs::read_to_string(project_root.join("project.json"))
            .map_err(|error| format!("Project manifest is unavailable: {error}"))?,
    )
    .map_err(|error| format!("Project manifest is invalid: {error}"))?;
    let source = project
        .get("assets")
        .and_then(Value::as_array)
        .and_then(|assets| {
            assets
                .iter()
                .find(|asset| asset.get("id").and_then(Value::as_str) == Some(asset_id))
        })
        .and_then(|asset| asset.get("src"))
        .and_then(Value::as_str)
        .ok_or_else(|| "Inpaint source asset was not found in the project".to_string())?;
    let relative = crate::storage::client_url_to_relative(project_id, source)
        .unwrap_or_else(|| source.to_string());
    let relative = crate::storage::safe_relative_path(&relative)
        .ok_or_else(|| "Inpaint source path is unsafe".to_string())?;
    let path = project_root.join(&relative);
    let bytes = std::fs::read(&path)
        .map_err(|error| format!("Unable to read inpaint source image: {error}"))?;
    if bytes.is_empty() || bytes.len() > 25 * 1024 * 1024 {
        return Err("Inpaint source image must be between 1 byte and 25 MB".to_string());
    }
    let mime = detect_image_mime(&bytes)?;
    Ok((bytes, mime))
}

fn decode_png_data_url(source: &str, label: &str) -> Result<Vec<u8>, String> {
    let data_url = source
        .strip_prefix("data:")
        .ok_or_else(|| format!("{label} must be a data URL"))?;
    let (header, encoded) = data_url
        .split_once(',')
        .ok_or_else(|| format!("{label} contains a malformed data URL"))?;
    if !header.ends_with(";base64") {
        return Err(format!("{label} must be base64 encoded"));
    }
    use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
    let bytes = BASE64
        .decode(encoded)
        .map_err(|error| format!("Invalid {label} base64: {error}"))?;
    if bytes.is_empty() || bytes.len() > MAX_REFERENCE_IMAGE_BYTES {
        return Err(format!("{label} must be between 1 byte and 8 MiB"));
    }
    if detect_image_mime(&bytes)? != "image/png" {
        return Err(format!("{label} must be a PNG image"));
    }
    Ok(bytes)
}

async fn generate_openai_inpaint(
    provider: &ImageProviderConfig,
    prompt: &str,
    size: &str,
    image: &[u8],
    image_mime: &str,
    mask: &[u8],
) -> Result<Vec<u8>, String> {
    let secret = optional_provider_secret(provider)?;
    let boundary = format!("knowmotion-{}", Uuid::new_v4().simple());
    let mut body = Vec::new();
    append_multipart_field(&mut body, &boundary, "model", &provider.model);
    append_multipart_field(&mut body, &boundary, "prompt", prompt);
    append_multipart_field(&mut body, &boundary, "n", "1");
    append_multipart_field(&mut body, &boundary, "size", size);
    append_multipart_file(
        &mut body,
        &boundary,
        "image",
        "source.png",
        image_mime,
        image,
    );
    append_multipart_file(&mut body, &boundary, "mask", "mask.png", "image/png", mask);
    body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
    let client = http_client()?;
    let api_prefix = if provider.protocol == STABLE_DIFFUSION_CPP_PROTOCOL {
        "/v1"
    } else {
        ""
    };
    let mut request = client
        .post(format!(
            "{}{api_prefix}/images/edits",
            provider.base_url.trim_end_matches('/')
        ))
        .header(
            reqwest::header::CONTENT_TYPE,
            format!("multipart/form-data; boundary={boundary}"),
        )
        .body(body);
    if let Some(secret) = secret {
        request = request.bearer_auth(secret);
    }
    let response = request.send().await.map_err(provider_network_error)?;
    let status = response.status();
    let payload: Value = response
        .json()
        .await
        .map_err(|_| format!("Image edit provider returned non-JSON response ({status})"))?;
    if !status.is_success() {
        let message = payload
            .pointer("/error/message")
            .and_then(Value::as_str)
            .unwrap_or("Image edit failed");
        return Err(format!(
            "Image edit provider returned {status}: {}",
            limit(message)
        ));
    }
    let item = payload
        .get("data")
        .and_then(Value::as_array)
        .and_then(|items| items.first())
        .ok_or_else(|| "Image edit provider returned no images".to_string())?;
    if let Some(encoded) = item.get("b64_json").and_then(Value::as_str) {
        use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
        return BASE64
            .decode(encoded)
            .map_err(|error| format!("Invalid edited image base64: {error}"));
    }
    if let Some(url) = item.get("url").and_then(Value::as_str) {
        return download_image(url).await;
    }
    Err("Image edit provider returned neither b64_json nor url".to_string())
}

/// 角色锁条件计划：前端协商后的结果在 Rust 侧再校验一次协议能力，
/// 并挑出真正要送进扩散模型的参考图字节。
#[derive(Debug, Clone)]
pub(crate) struct ConditionPlan {
    pub requested: String,
    pub effective: &'static str,
    pub strength: f32,
    pub control_type: String,
    pub start_at: f32,
    pub end_at: f32,
    pub primary_image: Option<Vec<u8>>,
    pub primary_asset_id: String,
    pub lock_count: usize,
    pub degradations: Vec<String>,
}

impl ConditionPlan {
    fn prompt_only() -> Self {
        Self {
            requested: "prompt".to_string(),
            effective: "prompt",
            strength: 0.55,
            control_type: "reference".to_string(),
            start_at: 0.0,
            end_at: 1.0,
            primary_image: None,
            primary_asset_id: String::new(),
            lock_count: 0,
            degradations: Vec::new(),
        }
    }
}

/// 把前端请求的条件通道对齐到协议真实能力，并挑选主参考图。
fn plan_conditioning(
    protocol: &str,
    input: Option<&ImageConditioningInput>,
    references: &[(&ImageReferenceInput, Vec<u8>)],
) -> ConditionPlan {
    let mut plan = ConditionPlan::prompt_only();
    let Some(input) = input else {
        return plan;
    };
    plan.requested = normalize_conditioning_mode(&input.mode).to_string();
    plan.strength = clamp_conditioning_strength(input.strength);
    plan.control_type = input.control_type.trim().to_ascii_lowercase();
    plan.start_at = input.start_at.clamp(0.0, 1.0);
    plan.end_at = input.end_at.clamp(0.0, 1.0);
    if plan.control_type.is_empty() {
        plan.control_type = "reference".to_string();
    }
    plan.lock_count = input.lock_count;

    let primary = if input.reference_asset_id.trim().is_empty() {
        references
            .iter()
            .max_by(|left, right| {
                reference_priority(left.0)
                    .partial_cmp(&reference_priority(right.0))
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
    } else {
        references
            .iter()
            .find(|(reference, _)| reference.asset_id == input.reference_asset_id)
            .or_else(|| {
                references
                    .iter()
                    .max_by(|left, right| {
                        reference_priority(left.0)
                            .partial_cmp(&reference_priority(right.0))
                            .unwrap_or(std::cmp::Ordering::Equal)
                    })
            })
    };
    if let Some((reference, bytes)) = primary {
        plan.primary_asset_id = reference.asset_id.clone();
        plan.primary_image = Some(bytes.clone());
    }

    if plan.requested == "prompt" {
        return plan;
    }
    if protocol != STABLE_DIFFUSION_CPP_PROTOCOL {
        plan.effective = "prompt";
        plan.degradations.push(format!(
            "{} 协议没有像素条件通道，{} 已降级为提示词锚点",
            protocol, plan.requested
        ));
        return plan;
    }
    if plan.primary_image.is_none() {
        plan.effective = "prompt";
        plan.degradations
            .push("该镜头没有可用的角色参考图，像素条件已降级为提示词锚点".to_string());
        return plan;
    }
    plan.effective = match plan.requested.as_str() {
        "controlnet" => "prompt+controlnet",
        "ip-adapter" => "prompt+ip-adapter",
        _ => "prompt+img2img",
    };
    plan
}

fn normalize_conditioning_mode(mode: &str) -> &str {
    match mode.trim().to_ascii_lowercase().as_str() {
        "controlnet" => "controlnet",
        "ip-adapter" | "ipadapter" | "ip_adapter" => "ip-adapter",
        "img2img" | "img2img-reference" | "reference" => "img2img-reference",
        _ => "prompt",
    }
}

fn clamp_conditioning_strength(strength: f32) -> f32 {
    if !strength.is_finite() || strength <= 0.0 {
        return 0.55;
    }
    strength.clamp(0.05, 0.95)
}

fn reference_priority(reference: &ImageReferenceInput) -> f32 {
    let role_bonus = if reference.role == "character" { 1.0 } else { 0.0 };
    role_bonus + reference.weight.clamp(0.0, 1.0)
}

fn parse_image_size(size: &str) -> (u32, u32) {
    let parsed = size
        .split_once(['x', 'X', '*'])
        .and_then(|(width, height)| {
            let width = width.trim().parse::<u32>().ok()?;
            let height = height.trim().parse::<u32>().ok()?;
            Some((width, height))
        });
    match parsed {
        Some((width, height)) if width >= 64 && height >= 64 && width <= 4096 && height <= 4096 => {
            (width, height)
        }
        _ => (1024, 1024),
    }
}

/// 图片生成的传输核心：只接受已实现的协议，并在调用本地扩散服务前
/// 申请 GPU 租约、启动或复用 `sd-server`。
///
/// 命令层、批量队列与真实服务验收共用这一实现。
pub(crate) async fn generate_images_for_provider(
    provider: &ImageProviderConfig,
    prompt: &str,
    size: &str,
    count: u8,
) -> Result<(Vec<Vec<u8>>, String), String> {
    let plan = ConditionPlan::prompt_only();
    let (images, mode, _) =
        generate_images_with_conditioning(provider, prompt, "", size, count, 0, &plan).await?;
    Ok((images, mode))
}

enum NativeFailure {
    /// 运行时没有原生接口（旧版本），可以安全降级。
    Unsupported(String),
    /// 真实生成失败，不能静默降级。
    Failed(String),
}

async fn generate_images_with_conditioning(
    provider: &ImageProviderConfig,
    prompt: &str,
    negative_prompt: &str,
    size: &str,
    count: u8,
    seed: i64,
    plan: &ConditionPlan,
) -> Result<(Vec<Vec<u8>>, String, Vec<String>), String> {
    match provider.protocol.as_str() {
        "OpenAI Compatible" => {
            // OpenAI Images generations 没有 pixel-level reference 通道；
            // 参考图已由前端写入锚点提示词，这里如实报告 prompt 模式。
            let images = generate_openai_images(provider, prompt, size, count).await?;
            Ok((images, "prompt".to_string(), Vec::new()))
        }
        STABLE_DIFFUSION_CPP_PROTOCOL => {
            let _local_lease = prepare_local_diffusion(provider).await?;
            let mut degradations = Vec::new();
            let mut effective = plan.effective;
            if matches!(effective, "prompt+controlnet" | "prompt+ip-adapter") {
                match generate_sd_cpp_native(provider, prompt, negative_prompt, size, count, seed, plan)
                    .await
                {
                    Ok(images) => return Ok((images, effective.to_string(), degradations)),
                    Err(NativeFailure::Unsupported(reason)) => {
                        degradations.push(reason);
                        effective = if plan.primary_image.is_some() {
                            "prompt+img2img"
                        } else {
                            "prompt"
                        };
                    }
                    Err(NativeFailure::Failed(message)) => return Err(message),
                }
            }
            if effective == "prompt+img2img" {
                let init_image = plan.primary_image.as_deref().ok_or_else(|| {
                    "Character lock requires a reference image, but none survived validation"
                        .to_string()
                })?;
                let images = generate_sd_cpp_img2img(
                    provider,
                    prompt,
                    negative_prompt,
                    size,
                    count,
                    seed,
                    plan.strength,
                    init_image,
                )
                .await?;
                return Ok((images, "prompt+img2img".to_string(), degradations));
            }
            let images = generate_openai_images(provider, prompt, size, count).await?;
            Ok((images, "prompt".to_string(), degradations))
        }
        other => Err(format!(
            "Provider protocol {other} does not implement Image generation"
        )),
    }
}

/// stable-diffusion.cpp 原生接口：ControlNet / IP-Adapter 条件通道。
/// 该接口是异步任务制，提交后需要轮询 `/sdcpp/v1/jobs/{id}`。
async fn generate_sd_cpp_native(
    provider: &ImageProviderConfig,
    prompt: &str,
    negative_prompt: &str,
    size: &str,
    count: u8,
    seed: i64,
    plan: &ConditionPlan,
) -> Result<Vec<Vec<u8>>, NativeFailure> {
    let payload = native_conditioning_payload(plan, prompt, negative_prompt, size, count, seed);
    let secret = optional_provider_secret(provider).map_err(NativeFailure::Failed)?;
    let base = provider.base_url.trim_end_matches('/').to_string();
    let client = http_client().map_err(NativeFailure::Failed)?;
    let mut request = client
        .post(format!("{base}/sdcpp/v1/img_gen"))
        .json(&payload);
    if let Some(secret) = secret {
        request = request.bearer_auth(secret);
    }
    let response = request
        .send()
        .await
        .map_err(|error| NativeFailure::Failed(provider_network_error(error)))?;
    let status = response.status();
    if status == reqwest::StatusCode::NOT_FOUND
        || status == reqwest::StatusCode::METHOD_NOT_ALLOWED
    {
        return Err(NativeFailure::Unsupported(format!(
            "当前 stable-diffusion.cpp 运行时没有 /sdcpp/v1/img_gen 原生接口，{} 通道不可用",
            plan.requested
        )));
    }
    let body: Value = response.json().await.map_err(|_| {
        NativeFailure::Failed(format!(
            "stable-diffusion.cpp 原生接口返回了非 JSON 响应（{status}）"
        ))
    })?;
    if !status.is_success() {
        let message = body
            .pointer("/error/message")
            .and_then(Value::as_str)
            .unwrap_or("原生图像生成失败");
        return Err(NativeFailure::Failed(format!(
            "stable-diffusion.cpp 原生接口返回 {status}: {}",
            limit(message)
        )));
    }
    if let Some(images) = job_images(&body) {
        return images.map_err(NativeFailure::Failed);
    }
    await_sd_cpp_job(&client, &base, &body)
        .await
        .map_err(NativeFailure::Failed)
}

fn native_conditioning_payload(
    plan: &ConditionPlan,
    prompt: &str,
    negative_prompt: &str,
    size: &str,
    count: u8,
    seed: i64,
) -> Value {
    use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
    let (width, height) = parse_image_size(size);
    let reference = plan
        .primary_image
        .as_deref()
        .map(|bytes| {
            let mime = detect_image_mime(bytes).unwrap_or("image/png");
            format!("data:{mime};base64,{}", BASE64.encode(bytes))
        })
        .unwrap_or_default();
    let mut payload = json!({
        "prompt": prompt,
        "negative_prompt": negative_prompt,
        "width": width,
        "height": height,
        "batch_count": count,
        "seed": seed,
        "output_format": "png",
    });
    if plan.effective == "prompt+controlnet" {
        payload["control_image"] = json!(reference);
        payload["control_strength"] = json!(plan.strength);
        if matches!(plan.control_type.as_str(), "pose" | "depth" | "canny" | "lineart") {
            payload["control_type"] = json!(plan.control_type);
        }
    } else if plan.effective == "prompt+ip-adapter" {
        payload["ip_adapter_image"] = json!(reference);
        payload["ip_adapter_strength"] = json!(plan.strength);
    }
    payload
}

/// 从任务 JSON 里取出结果图像；任务尚未完成时返回 `None`。
fn job_images(body: &Value) -> Option<Result<Vec<Vec<u8>>, String>> {
    let images = body.pointer("/result/images")?.as_array()?;
    if images.is_empty() {
        return Some(Err("图像任务完成但没有返回任何图像".to_string()));
    }
    let mut decoded = Vec::with_capacity(images.len());
    for item in images {
        let Some(encoded) = item.get("b64_json").and_then(Value::as_str) else {
            return Some(Err("图像任务返回的条目缺少 b64_json".to_string()));
        };
        match decode_base64_image(encoded) {
            Ok(bytes) => decoded.push(bytes),
            Err(error) => return Some(Err(error)),
        }
    }
    Some(Ok(decoded))
}

fn decode_base64_image(value: &str) -> Result<Vec<u8>, String> {
    use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
    let encoded = match value.split_once(',') {
        Some((header, payload)) if header.starts_with("data:") => payload,
        _ => value,
    };
    BASE64
        .decode(encoded.trim())
        .map_err(|error| format!("图像任务返回了非法 base64：{error}"))
}

async fn await_sd_cpp_job(
    client: &Client,
    base: &str,
    job: &Value,
) -> Result<Vec<Vec<u8>>, String> {
    let id = job.get("id").and_then(Value::as_str).unwrap_or_default();
    let poll_url = match job.get("poll_url").and_then(Value::as_str) {
        Some(path) if path.starts_with("http") => path.to_string(),
        Some(path) => format!("{base}{path}"),
        None if !id.is_empty() => format!("{base}/sdcpp/v1/jobs/{id}"),
        None => return Err("stable-diffusion.cpp 没有返回任务 ID".to_string()),
    };
    let deadline = Instant::now() + SD_CPP_JOB_TIMEOUT;
    loop {
        if Instant::now() >= deadline {
            return Err(format!(
                "stable-diffusion.cpp 图像任务超过 {} 秒仍未完成",
                SD_CPP_JOB_TIMEOUT.as_secs()
            ));
        }
        tokio::time::sleep(SD_CPP_JOB_POLL_INTERVAL).await;
        let response = client
            .get(&poll_url)
            .send()
            .await
            .map_err(provider_network_error)?;
        let status = response.status();
        let state: Value = response
            .json()
            .await
            .map_err(|_| format!("stable-diffusion.cpp 任务状态返回了非 JSON 响应（{status}）"))?;
        if !status.is_success() {
            return Err(format!("stable-diffusion.cpp 任务查询失败：{status}"));
        }
        match state.get("status").and_then(Value::as_str).unwrap_or_default() {
            "completed" => {
                return job_images(&state)
                    .unwrap_or_else(|| Err("图像任务完成但没有返回图像".to_string()));
            }
            "failed" | "cancelled" | "canceled" => {
                let message = state
                    .pointer("/error/message")
                    .and_then(Value::as_str)
                    .unwrap_or("图像任务失败");
                return Err(format!("stable-diffusion.cpp 图像任务失败：{}", limit(message)));
            }
            _ => continue,
        }
    }
}

/// img2img 参考锁定：以角色参考图为初始图重绘，`denoising_strength` 由锁定权重决定。
async fn generate_sd_cpp_img2img(
    provider: &ImageProviderConfig,
    prompt: &str,
    negative_prompt: &str,
    size: &str,
    count: u8,
    seed: i64,
    strength: f32,
    init_image: &[u8],
) -> Result<Vec<Vec<u8>>, String> {
    use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
    let (width, height) = parse_image_size(size);
    let mime = detect_image_mime(init_image)?;
    let secret = optional_provider_secret(provider)?;
    let client = http_client()?;
    let payload = json!({
        "prompt": prompt,
        "negative_prompt": negative_prompt,
        "width": width,
        "height": height,
        "batch_size": count,
        "seed": seed,
        "denoising_strength": clamp_conditioning_strength(strength),
        "init_images": [format!("data:{mime};base64,{}", BASE64.encode(init_image))],
    });
    let mut request = client
        .post(format!(
            "{}/sdapi/v1/img2img",
            provider.base_url.trim_end_matches('/')
        ))
        .json(&payload);
    if let Some(secret) = secret {
        request = request.bearer_auth(secret);
    }
    let response = request.send().await.map_err(provider_network_error)?;
    let status = response.status();
    let body: Value = response
        .json()
        .await
        .map_err(|_| format!("stable-diffusion.cpp 返回了非 JSON 响应（{status}）"))?;
    if !status.is_success() {
        let message = body
            .pointer("/error/message")
            .and_then(Value::as_str)
            .unwrap_or("img2img 参考锁定失败");
        return Err(format!(
            "stable-diffusion.cpp img2img 返回 {status}: {}",
            limit(message)
        ));
    }
    let images = body
        .get("images")
        .and_then(Value::as_array)
        .ok_or_else(|| "stable-diffusion.cpp img2img 没有返回图像".to_string())?;
    let mut decoded = Vec::with_capacity(images.len());
    for item in images {
        let encoded = item
            .as_str()
            .ok_or_else(|| "stable-diffusion.cpp img2img 返回了非字符串图像".to_string())?;
        decoded.push(decode_base64_image(encoded)?);
    }
    if decoded.is_empty() {
        return Err("stable-diffusion.cpp img2img 返回了空图像列表".to_string());
    }
    Ok(decoded)
}

async fn generate_openai_images(
    provider: &ImageProviderConfig,
    prompt: &str,
    size: &str,
    count: u8,
) -> Result<Vec<Vec<u8>>, String> {
    let secret = optional_provider_secret(provider)?;
    let endpoint = format!(
        "{}{}/images/generations",
        provider.base_url.trim_end_matches('/'),
        if provider.protocol == STABLE_DIFFUSION_CPP_PROTOCOL {
            "/v1"
        } else {
            ""
        }
    );
    let client = http_client()?;
    let mut request = client.post(endpoint).json(&json!({
        "model": provider.model,
        "prompt": prompt,
        "n": count,
        "size": size,
        "response_format": "b64_json"
    }));
    if let Some(secret) = secret {
        request = request.bearer_auth(secret);
    }
    let response = request.send().await.map_err(provider_network_error)?;
    let status = response.status();
    let body: Value = response
        .json()
        .await
        .map_err(|_| format!("Image provider returned non-JSON response ({status})"))?;
    if !status.is_success() {
        let message = body
            .pointer("/error/message")
            .and_then(Value::as_str)
            .unwrap_or("Image generation failed");
        return Err(format!(
            "Image provider returned {status}: {}",
            limit(message)
        ));
    }
    let data = body
        .get("data")
        .and_then(Value::as_array)
        .ok_or_else(|| "Image provider response has no data array".to_string())?;
    let mut images = Vec::new();
    for item in data {
        if let Some(encoded) = item.get("b64_json").and_then(Value::as_str) {
            use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
            images.push(
                BASE64
                    .decode(encoded)
                    .map_err(|error| format!("Invalid image base64: {error}"))?,
            );
        } else if let Some(url) = item.get("url").and_then(Value::as_str) {
            images.push(download_image(url).await?);
        }
    }
    if images.is_empty() {
        return Err("Image provider returned no images".to_string());
    }
    Ok(images)
}

async fn download_image(url: &str) -> Result<Vec<u8>, String> {
    let fetched = tokio::time::timeout(
        Duration::from_secs(120),
        fetch_public_http(url, IMAGE_HTTP_POLICY),
    )
    .await
    .map_err(|_| "Image download timed out".to_string())?
    .map_err(|error| format!("Image download rejected: {error}"))?;
    Ok(fetched.bytes)
}

fn http_client() -> Result<Client, String> {
    Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(180))
        .user_agent("KnowMotion-AI-Studio/0.1")
        .build()
        .map_err(|error| format!("Unable to create image client: {error}"))
}

fn provider_network_error(error: reqwest::Error) -> String {
    if error.is_timeout() {
        "Image provider request timed out".to_string()
    } else {
        "Image provider network request failed".to_string()
    }
}

fn detect_image_mime(bytes: &[u8]) -> Result<&'static str, String> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Ok("image/png")
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        Ok("image/jpeg")
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        Ok("image/webp")
    } else {
        Err("Provider returned an unsupported image format".to_string())
    }
}

fn limit(value: &str) -> String {
    value.chars().take(500).collect()
}

fn append_multipart_field(body: &mut Vec<u8>, boundary: &str, name: &str, value: &str) {
    body.extend_from_slice(
        format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n"
        )
        .as_bytes(),
    );
}

fn append_multipart_file(
    body: &mut Vec<u8>,
    boundary: &str,
    name: &str,
    filename: &str,
    content_type: &str,
    data: &[u8],
) {
    body.extend_from_slice(
        format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"; filename=\"{filename}\"\r\nContent-Type: {content_type}\r\n\r\n"
        )
        .as_bytes(),
    );
    body.extend_from_slice(data);
    body.extend_from_slice(b"\r\n");
}

fn chunk_knowledge(texts: &[String]) -> Vec<String> {
    let combined = texts.join("\n\n");
    let characters = combined.chars().collect::<Vec<_>>();
    let chunk_size = 1_400;
    let overlap = 180;
    let mut chunks = Vec::new();
    let mut start = 0;
    while start < characters.len() {
        let end = (start + chunk_size).min(characters.len());
        let text = characters[start..end]
            .iter()
            .collect::<String>()
            .trim()
            .to_string();
        if !text.is_empty() {
            chunks.push(text);
        }
        if end == characters.len() {
            break;
        }
        start = end.saturating_sub(overlap);
    }
    chunks
}

pub(crate) async fn request_embeddings(
    provider: &ImageProviderConfig,
    texts: &[String],
) -> Result<Vec<Vec<f32>>, String> {
    let secret = get_provider_secret(&provider.id)
        .ok_or_else(|| "No API key is stored for the embedding provider".to_string())?;
    let response = http_client()?
        .post(format!(
            "{}/embeddings",
            provider.base_url.trim_end_matches('/')
        ))
        .bearer_auth(secret)
        .json(&json!({ "model": provider.model, "input": texts }))
        .send()
        .await
        .map_err(provider_network_error)?;
    let status = response.status();
    let payload: Value = response
        .json()
        .await
        .map_err(|_| format!("Embedding provider returned non-JSON response ({status})"))?;
    if !status.is_success() {
        return Err(format!("Embedding provider returned {status}"));
    }
    payload
        .get("data")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            // 本地 llama.cpp 在缺少 `/v1` 前缀时会返回 legacy 数组形态，
            // 这里把实际结构带回调用方，避免只看到一句「没有 data」。
            format!(
                "Embedding response has no data array; base URL must point at the versioned endpoint (got {})",
                limit(&payload.to_string())
            )
        })?
        .iter()
        .map(|item| {
            item.get("embedding")
                .and_then(Value::as_array)
                .ok_or_else(|| "Embedding item has no vector".to_string())?
                .iter()
                .map(|value| {
                    value
                        .as_f64()
                        .map(|value| value as f32)
                        .ok_or_else(|| "Embedding vector contains a non-number".to_string())
                })
                .collect::<Result<Vec<_>, _>>()
        })
        .collect()
}

pub(crate) fn cosine_similarity(left: &[f32], right: &[f32]) -> Option<f64> {
    if left.len() != right.len() || left.is_empty() {
        return None;
    }
    let mut dot = 0.0_f64;
    let mut left_norm = 0.0_f64;
    let mut right_norm = 0.0_f64;
    for (left, right) in left.iter().zip(right.iter()) {
        dot += f64::from(*left) * f64::from(*right);
        left_norm += f64::from(*left).powi(2);
        right_norm += f64::from(*right).powi(2);
    }
    let denominator = left_norm.sqrt() * right_norm.sqrt();
    (denominator > 0.0).then_some(dot / denominator)
}

fn extract_tag_text(html: &str, tag: &str) -> Option<String> {
    let lowercase = html.to_ascii_lowercase();
    let start = lowercase.find(&format!("<{tag}"))?;
    let content_start = lowercase[start..].find('>')? + start + 1;
    let end = lowercase[content_start..].find(&format!("</{tag}>"))? + content_start;
    Some(decode_html_entities(html[content_start..end].trim()))
}

fn html_to_text(html: &str) -> String {
    let mut output = String::with_capacity(html.len());
    let mut in_tag = false;
    let mut tag = String::new();
    let mut skip_depth = 0_u32;
    for character in html.chars() {
        if character == '<' {
            in_tag = true;
            tag.clear();
        } else if character == '>' {
            let normalized = tag.trim().to_ascii_lowercase();
            let closing = normalized.starts_with('/');
            let name = normalized
                .trim_start_matches('/')
                .split_whitespace()
                .next()
                .unwrap_or_default();
            if matches!(name, "script" | "style") {
                if closing {
                    skip_depth = skip_depth.saturating_sub(1);
                } else {
                    skip_depth += 1;
                }
            }
            in_tag = false;
            output.push(' ');
        } else if !in_tag && skip_depth == 0 {
            output.push(character);
        } else if in_tag {
            tag.push(character);
        }
    }
    decode_html_entities(&output)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn decode_html_entities(value: &str) -> String {
    value
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_provider_image_mime_signature() {
        assert_eq!(
            detect_image_mime(b"\x89PNG\r\n\x1a\nrest").expect("PNG"),
            "image/png"
        );
        assert!(detect_image_mime(b"not-an-image").is_err());
    }

    #[test]
    fn html_extraction_removes_scripts_and_preserves_text() {
        let text = html_to_text(
            "<html><title>Source</title><style>x{}</style><script>bad()</script><p>Useful&nbsp;knowledge.</p></html>",
        );
        assert!(text.contains("Useful knowledge"));
        assert!(!text.contains("bad()"));
    }

    #[test]
    fn cosine_similarity_handles_parallel_vectors() {
        let score = cosine_similarity(&[1.0, 0.0], &[1.0, 0.0]).expect("score");
        assert!((score - 1.0).abs() < 0.0001);
    }

    #[test]
    fn parses_audio_cpp_sample_offsets_into_seconds() {
        let cues = parse_asr_cues(&json!({
            "sample_rate": 16000,
            "segments": [
                {
                    "start_sample": 16000,
                    "end_sample": 32000,
                    "text": "知识动画"
                }
            ]
        }));
        assert_eq!(cues.len(), 1);
        assert_eq!(cues[0].start, 1.0);
        assert_eq!(cues[0].end, 2.0);
        assert_eq!(cues[0].text, "知识动画");
    }

    #[test]
    fn prefers_openai_style_segment_seconds() {
        let cues = parse_asr_cues(&json!({
            "segments": [
                {"start": 0.5, "end": 1.75, "text": "字幕"}
            ]
        }));
        assert_eq!(cues.len(), 1);
        assert_eq!(cues[0].start, 0.5);
        assert_eq!(cues[0].end, 1.75);
    }

    #[test]
    fn mask_decoder_accepts_only_png_data_urls() {
        use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
        let png = format!(
            "data:image/png;base64,{}",
            BASE64.encode(b"\x89PNG\r\n\x1a\nmask")
        );
        assert_eq!(
            decode_png_data_url(&png, "mask").expect("png mask"),
            b"\x89PNG\r\n\x1a\nmask"
        );
        assert!(decode_png_data_url("https://example.com/mask.png", "mask").is_err());
        let jpeg = format!(
            "data:image/jpeg;base64,{}",
            BASE64.encode(b"\xff\xd8\xffjpeg")
        );
        assert!(decode_png_data_url(&jpeg, "mask").is_err());
        assert!(decode_png_data_url("data:image/png;base64,!!!", "mask").is_err());
    }

    #[test]
    fn reference_bytes_accept_project_assets_and_data_urls_only() {
        let temp = tempfile::tempdir().expect("temp dir");
        let project_root = temp.path().join("project-1");
        std::fs::create_dir_all(project_root.join("assets/images")).expect("dirs");
        std::fs::write(
            project_root.join("assets/images/ref.png"),
            b"\x89PNG\r\n\x1a\npayload",
        )
        .expect("write");

        let local = read_reference_bytes(temp.path(), "project-1", "assets/images/ref.png")
            .expect("local reference");
        assert_eq!(local, b"\x89PNG\r\n\x1a\npayload");

        use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
        let encoded = BASE64.encode(b"\x89PNG\r\n\x1a\ndata-url");
        let decoded = read_reference_bytes(
            temp.path(),
            "project-1",
            &format!("data:image/png;base64,{encoded}"),
        )
        .expect("data url reference");
        assert_eq!(decoded, b"\x89PNG\r\n\x1a\ndata-url");

        assert!(
            read_reference_bytes(temp.path(), "project-1", "https://example.com/ref.png").is_err()
        );
        assert!(read_reference_bytes(temp.path(), "project-1", "../secret.png").is_err());
        assert!(
            read_reference_bytes(temp.path(), "project-1", "assets/images/missing.png").is_err()
        );
    }

    fn character_reference(asset_id: &str, weight: f32) -> ImageReferenceInput {
        ImageReferenceInput {
            asset_id: asset_id.to_string(),
            role: "character".to_string(),
            label: "林博士".to_string(),
            weight,
            source: format!("data:image/png;base64,{asset_id}"),
        }
    }

    #[test]
    fn conditioning_plan_requires_a_reference_image() {
        let input = ImageConditioningInput {
            mode: "controlnet".to_string(),
            strength: 0.6,
            reference_asset_id: String::new(),
            control_type: "pose".to_string(),
            start_at: 0.0,
            end_at: 1.0,
            lock_count: 1,
        };
        let plan = plan_conditioning(STABLE_DIFFUSION_CPP_PROTOCOL, Some(&input), &[]);
        assert_eq!(plan.effective, "prompt");
        assert_eq!(plan.degradations.len(), 1);
        assert!(plan.degradations[0].contains("参考图"));
    }

    #[test]
    fn conditioning_plan_honours_declared_controlnet_on_sd_cpp() {
        let input = ImageConditioningInput {
            mode: "controlnet".to_string(),
            strength: 1.7,
            reference_asset_id: "asset_ref".to_string(),
            control_type: "Pose".to_string(),
            start_at: 0.2,
            end_at: 1.0,
            lock_count: 1,
        };
        let reference = character_reference("asset_ref", 0.8);
        let bytes = b"\x89PNG\r\n\x1a\npayload".to_vec();
        let plan = plan_conditioning(
            STABLE_DIFFUSION_CPP_PROTOCOL,
            Some(&input),
            &[(&reference, bytes.clone())],
        );
        assert_eq!(plan.effective, "prompt+controlnet");
        assert_eq!(plan.strength, 0.95);
        assert_eq!(plan.control_type, "pose");
        assert_eq!(plan.primary_asset_id, "asset_ref");
        assert_eq!(plan.primary_image.expect("primary image"), bytes);
    }

    #[test]
    fn conditioning_plan_degrades_for_prompt_only_providers() {
        let input = ImageConditioningInput {
            mode: "ip-adapter".to_string(),
            ..Default::default()
        };
        let reference = character_reference("asset_ref", 0.9);
        let plan = plan_conditioning(
            "OpenAI Compatible",
            Some(&input),
            &[(&reference, b"\x89PNG\r\n\x1a\npayload".to_vec())],
        );
        assert_eq!(plan.effective, "prompt");
        assert_eq!(plan.degradations.len(), 1);
        assert!(plan.degradations[0].contains("OpenAI Compatible"));
    }

    #[test]
    fn native_payload_carries_the_control_image() {
        let input = ImageConditioningInput {
            mode: "controlnet".to_string(),
            strength: 0.4,
            reference_asset_id: "asset_ref".to_string(),
            control_type: "depth".to_string(),
            start_at: 0.0,
            end_at: 1.0,
            lock_count: 1,
        };
        let reference = character_reference("asset_ref", 0.7);
        let plan = plan_conditioning(
            STABLE_DIFFUSION_CPP_PROTOCOL,
            Some(&input),
            &[(&reference, b"\x89PNG\r\n\x1a\npayload".to_vec())],
        );
        let payload = native_conditioning_payload(&plan, "a scientist", "blurry", "1536x1024", 2, 42);
        assert_eq!(payload["width"], 1536);
        assert_eq!(payload["height"], 1024);
        assert_eq!(payload["batch_count"], 2);
        assert!((payload["control_strength"].as_f64().expect("strength") - 0.4).abs() < 0.001);
        assert_eq!(payload["control_type"], "depth");
        assert!(payload["control_image"]
            .as_str()
            .expect("control image")
            .starts_with("data:image/png;base64,"));
        assert!(payload.get("ip_adapter_image").is_none());
    }

    #[test]
    fn native_payload_uses_ip_adapter_for_adapter_locks() {
        let input = ImageConditioningInput {
            mode: "ip-adapter".to_string(),
            strength: 0.7,
            ..Default::default()
        };
        let reference = character_reference("asset_ref", 0.9);
        let plan = plan_conditioning(
            STABLE_DIFFUSION_CPP_PROTOCOL,
            Some(&input),
            &[(&reference, b"\x89PNG\r\n\x1a\npayload".to_vec())],
        );
        let payload = native_conditioning_payload(&plan, "p", "", "1024x1024", 1, 7);
        assert!(payload["ip_adapter_image"].is_string());
        assert!((payload["ip_adapter_strength"].as_f64().expect("strength") - 0.7).abs() < 0.001);
        assert!(payload.get("control_image").is_none());
    }

    #[test]
    fn image_size_parsing_falls_back_to_one_megapixel() {
        assert_eq!(parse_image_size("1536x1024"), (1536, 1024));
        assert_eq!(parse_image_size("1024 x 1024"), (1024, 1024));
        assert_eq!(parse_image_size("garbage"), (1024, 1024));
        assert_eq!(parse_image_size("10x10"), (1024, 1024));
    }

    #[test]
    fn job_images_decode_base64_and_data_urls() {
        use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
        let encoded = BASE64.encode(b"\x89PNG\r\n\x1a\njob");
        let job = json!({
            "status": "completed",
            "result": { "images": [
                { "index": 0, "b64_json": encoded },
                { "index": 1, "b64_json": format!("data:image/png;base64,{encoded}") }
            ] }
        });
        let images = job_images(&job).expect("images").expect("decoded");
        assert_eq!(images.len(), 2);
        assert_eq!(images[0], b"\x89PNG\r\n\x1a\njob");
        assert_eq!(images[1], b"\x89PNG\r\n\x1a\njob");
        assert!(job_images(&json!({ "status": "queued" })).is_none());
    }

    #[test]
    fn conditioning_strength_is_clamped_into_a_safe_range() {
        assert_eq!(clamp_conditioning_strength(0.0), 0.55);
        assert_eq!(clamp_conditioning_strength(f32::NAN), 0.55);
        assert_eq!(clamp_conditioning_strength(-1.0), 0.55);
        assert_eq!(clamp_conditioning_strength(0.01), 0.05);
        assert_eq!(clamp_conditioning_strength(4.0), 0.95);
    }
}
