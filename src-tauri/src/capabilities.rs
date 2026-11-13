use crate::{
    agent::get_provider_secret, logging, logging::LogLevel, safe_identifier,
    storage::persist_generated_image, AppState,
};
use chrono::Utc;
use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    net::IpAddr,
    time::{Duration, Instant},
};
use tauri::State;
use uuid::Uuid;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageProviderConfig {
    pub id: String,
    pub name: String,
    pub protocol: String,
    pub base_url: String,
    pub model: String,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub capabilities: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageGenerationRequest {
    pub project_id: String,
    pub scene_id: String,
    pub provider: ImageProviderConfig,
    pub prompt: String,
    pub style: String,
    pub size: String,
    pub count: u8,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageGenerationResult {
    pub assets: Vec<Value>,
    pub provider_id: String,
    pub model: String,
    pub elapsed_ms: u128,
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
    if request.provider.protocol != "OpenAI Compatible"
        || !request
            .provider
            .capabilities
            .iter()
            .any(|capability| capability == "ASR")
    {
        return Err("ASR requires an enabled OpenAI-compatible provider".to_string());
    }
    let secret = get_provider_secret(&request.provider.id)
        .ok_or_else(|| "No API key is stored for the ASR provider".to_string())?;
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
            assets.iter().find(|asset| {
                asset.get("id").and_then(Value::as_str) == Some(&request.asset_id)
            })
        })
        .and_then(|asset| asset.get("src"))
        .and_then(Value::as_str)
        .ok_or_else(|| "ASR source asset was not found in the project manifest".to_string())?;
    let relative = crate::storage::client_url_to_relative(&request.project_id, source)
        .unwrap_or_else(|| source.to_string());
    let relative = crate::storage::safe_relative_path(&relative)
        .ok_or_else(|| "ASR source path is unsafe".to_string())?;
    let audio_path = project_root.join(&relative);
    let audio = std::fs::read(&audio_path)
        .map_err(|error| format!("Unable to read ASR audio: {error}"))?;
    if audio.is_empty() || audio.len() > 25 * 1024 * 1024 {
        return Err("ASR audio must be between 1 byte and 25 MB".to_string());
    }
    let filename = audio_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("audio.wav");
    let content_type = if audio.starts_with(b"RIFF") {
        "audio/wav"
    } else {
        "audio/mpeg"
    };
    let boundary = format!("knowmotion-{}", Uuid::new_v4().simple());
    let mut body = Vec::new();
    append_multipart_field(&mut body, &boundary, "model", &request.provider.model);
    append_multipart_field(&mut body, &boundary, "response_format", "verbose_json");
    append_multipart_file(
        &mut body,
        &boundary,
        "file",
        filename,
        content_type,
        &audio,
    );
    body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
    let started = Instant::now();
    let response = http_client()?
        .post(format!(
            "{}/audio/transcriptions",
            request.provider.base_url.trim_end_matches('/')
        ))
        .bearer_auth(secret)
        .header(
            reqwest::header::CONTENT_TYPE,
            format!("multipart/form-data; boundary={boundary}"),
        )
        .body(body)
        .send()
        .await
        .map_err(provider_network_error)?;
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
    let cues = payload
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
    logging::log_event(
        LogLevel::Info,
        "provider.asr",
        "Audio transcription completed",
        Some(json!({
            "projectId": request.project_id,
            "assetId": request.asset_id,
            "providerId": request.provider.id,
            "model": request.provider.model,
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
    if dimensions == 0 || embeddings.iter().any(|embedding| embedding.len() != dimensions) {
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
    let url = reqwest::Url::parse(&request.url)
        .map_err(|error| format!("Invalid research URL: {error}"))?;
    validate_public_url(&url)?;
    let client = Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(60))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 5 || validate_public_url(attempt.url()).is_err() {
                attempt.stop()
            } else {
                attempt.follow()
            }
        }))
        .user_agent("KnowMotion-AI-Studio/0.1")
        .build()
        .map_err(|error| error.to_string())?;
    let response = client
        .get(url.clone())
        .send()
        .await
        .map_err(provider_network_error)?;
    if !response.status().is_success() {
        return Err(format!("Research source returned {}", response.status()));
    }
    if response.content_length().unwrap_or(0) > 5 * 1024 * 1024 {
        return Err("Research source exceeds the 5 MB text limit".to_string());
    }
    let bytes = response
        .bytes()
        .await
        .map_err(provider_network_error)?;
    if bytes.len() > 5 * 1024 * 1024 {
        return Err("Research source exceeds the 5 MB text limit".to_string());
    }
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
            "extractedCharacters": text.chars().count()
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
    if request.provider.protocol != "OpenAI Compatible" {
        return Err(
            "Cloud TTS currently requires an OpenAI-compatible speech endpoint".to_string(),
        );
    }
    if request.scenes.is_empty() || request.scenes.len() > 100 {
        return Err("TTS request must contain between 1 and 100 scenes".to_string());
    }
    let secret = get_provider_secret(&request.provider.id)
        .ok_or_else(|| "No API key is stored for the TTS provider".to_string())?;
    let endpoint = format!(
        "{}/audio/speech",
        request.provider.base_url.trim_end_matches('/')
    );
    let client = http_client()?;
    let started = Instant::now();
    let mut assets = Vec::new();
    let mut total_audio_ms = 0_i64;
    for scene in &request.scenes {
        if scene.narration.trim().is_empty() {
            continue;
        }
        let response = client
            .post(&endpoint)
            .bearer_auth(&secret)
            .json(&json!({
                "model": request.provider.model,
                "input": scene.narration,
                "voice": if request.voice.trim().is_empty() { "alloy" } else { request.voice.trim() },
                "response_format": "wav",
                "speed": request.rate.clamp(0.5, 2.0)
            }))
            .send()
            .await
            .map_err(provider_network_error)?;
        let status = response.status();
        if !status.is_success() {
            return Err(format!("TTS provider returned {status}"));
        }
        let bytes = response
            .bytes()
            .await
            .map_err(provider_network_error)?
            .to_vec();
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

fn wav_duration_ms(bytes: &[u8]) -> Result<i64, String> {
    let reader = hound::WavReader::new(std::io::Cursor::new(bytes))
        .map_err(|error| format!("TTS response is not a valid WAV file: {error}"))?;
    let spec = reader.spec();
    let duration_ms = (reader.duration() as f64 / spec.sample_rate as f64 * 1000.0).round() as i64;
    if duration_ms <= 0 {
        return Err("TTS response WAV has no audio samples".to_string());
    }
    Ok(duration_ms)
}

#[tauri::command]
pub async fn generate_project_images(
    state: State<'_, AppState>,
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
    let started = Instant::now();
    let images = match request.provider.protocol.as_str() {
        "OpenAI Compatible" => {
            generate_openai_images(&request.provider, &prompt, &request.size, count).await?
        }
        "ComfyUI" => generate_comfyui_images(&request.provider, &prompt, &request.size).await?,
        other => {
            return Err(format!(
                "Provider protocol {other} does not implement Image generation"
            ))
        }
    };

    let mut assets = Vec::new();
    for (index, bytes) in images.into_iter().enumerate() {
        let asset_id = format!("asset_{}", Uuid::new_v4().simple());
        let mime_type = detect_image_mime(&bytes)?;
        let (relative, mime_type, _sha256) = persist_generated_image(
            &state.projects_root,
            &request.project_id,
            &asset_id,
            &bytes,
            mime_type,
        )?;
        assets.push(json!({
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
        }));
    }

    if let Ok(database) = state.database.lock() {
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
            "elapsedMs": started.elapsed().as_millis()
        })),
    );
    Ok(ImageGenerationResult {
        assets,
        provider_id: request.provider.id,
        model: request.provider.model,
        elapsed_ms: started.elapsed().as_millis(),
    })
}

async fn generate_openai_images(
    provider: &ImageProviderConfig,
    prompt: &str,
    size: &str,
    count: u8,
) -> Result<Vec<Vec<u8>>, String> {
    let secret = get_provider_secret(&provider.id)
        .ok_or_else(|| "No API key is stored for the image provider".to_string())?;
    let endpoint = format!(
        "{}/images/generations",
        provider.base_url.trim_end_matches('/')
    );
    let client = http_client()?;
    let response = client
        .post(endpoint)
        .bearer_auth(secret)
        .json(&json!({
            "model": provider.model,
            "prompt": prompt,
            "n": count,
            "size": size,
            "response_format": "b64_json"
        }))
        .send()
        .await
        .map_err(provider_network_error)?;
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
        return Err(format!("Image provider returned {status}: {}", limit(message)));
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
            images.push(download_image(&client, url).await?);
        }
    }
    if images.is_empty() {
        return Err("Image provider returned no images".to_string());
    }
    Ok(images)
}

async fn generate_comfyui_images(
    provider: &ImageProviderConfig,
    prompt: &str,
    size: &str,
) -> Result<Vec<Vec<u8>>, String> {
    let (width, height) = parse_image_size(size)?;
    let base = provider.base_url.trim_end_matches('/');
    let client = http_client()?;
    let workflow = json!({
        "3": {
            "class_type": "KSampler",
            "inputs": {
                "seed": Utc::now().timestamp_subsec_nanos(),
                "steps": 24,
                "cfg": 7.0,
                "sampler_name": "euler",
                "scheduler": "normal",
                "denoise": 1.0,
                "model": ["4", 0],
                "positive": ["6", 0],
                "negative": ["7", 0],
                "latent_image": ["5", 0]
            }
        },
        "4": {
            "class_type": "CheckpointLoaderSimple",
            "inputs": { "ckpt_name": provider.model }
        },
        "5": {
            "class_type": "EmptyLatentImage",
            "inputs": { "width": width, "height": height, "batch_size": 1 }
        },
        "6": {
            "class_type": "CLIPTextEncode",
            "inputs": { "text": prompt, "clip": ["4", 1] }
        },
        "7": {
            "class_type": "CLIPTextEncode",
            "inputs": {
                "text": "blurry, low quality, text artifacts, watermark",
                "clip": ["4", 1]
            }
        },
        "8": {
            "class_type": "VAEDecode",
            "inputs": { "samples": ["3", 0], "vae": ["4", 2] }
        },
        "9": {
            "class_type": "SaveImage",
            "inputs": { "filename_prefix": "knowmotion", "images": ["8", 0] }
        }
    });
    let response = client
        .post(format!("{base}/prompt"))
        .json(&json!({
            "prompt": workflow,
            "client_id": Uuid::new_v4().to_string()
        }))
        .send()
        .await
        .map_err(provider_network_error)?;
    let status = response.status();
    let body: Value = response
        .json()
        .await
        .map_err(|_| format!("ComfyUI returned non-JSON response ({status})"))?;
    if !status.is_success() {
        return Err(format!(
            "ComfyUI rejected the workflow ({status}): {}",
            limit(&body.to_string())
        ));
    }
    let prompt_id = body
        .get("prompt_id")
        .and_then(Value::as_str)
        .ok_or_else(|| "ComfyUI response has no prompt_id".to_string())?;
    let mut image_ref = None;
    for _ in 0..240 {
        tokio::time::sleep(Duration::from_millis(500)).await;
        let response = client
            .get(format!("{base}/history/{prompt_id}"))
            .send()
            .await
            .map_err(provider_network_error)?;
        if !response.status().is_success() {
            continue;
        }
        let history: Value = response
            .json()
            .await
            .map_err(|error| format!("Invalid ComfyUI history: {error}"))?;
        if let Some(image) = history
            .get(prompt_id)
            .and_then(|entry| entry.pointer("/outputs/9/images/0"))
        {
            image_ref = Some(image.clone());
            break;
        }
    }
    let image = image_ref.ok_or_else(|| {
        "ComfyUI generation timed out before producing a history image".to_string()
    })?;
    let filename = image
        .get("filename")
        .and_then(Value::as_str)
        .ok_or_else(|| "ComfyUI image has no filename".to_string())?;
    let subfolder = image
        .get("subfolder")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let image_type = image
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("output");
    let response = client
        .get(format!(
            "{base}/view?filename={}&subfolder={}&type={}",
            utf8_percent_encode(filename, NON_ALPHANUMERIC),
            utf8_percent_encode(subfolder, NON_ALPHANUMERIC),
            utf8_percent_encode(image_type, NON_ALPHANUMERIC)
        ))
        .send()
        .await
        .map_err(provider_network_error)?;
    if !response.status().is_success() {
        return Err(format!(
            "ComfyUI image download failed with {}",
            response.status()
        ));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(provider_network_error)?
        .to_vec();
    Ok(vec![bytes])
}

async fn download_image(client: &Client, url: &str) -> Result<Vec<u8>, String> {
    let parsed = reqwest::Url::parse(url).map_err(|error| format!("Invalid image URL: {error}"))?;
    let host = parsed
        .host_str()
        .ok_or_else(|| "Image URL has no host".to_string())?;
    if host.eq_ignore_ascii_case("localhost")
        || host.parse::<IpAddr>().is_ok_and(is_disallowed_ip)
    {
        return Err("Image URL resolves to a disallowed local/private host".to_string());
    }
    let response = client
        .get(parsed)
        .send()
        .await
        .map_err(provider_network_error)?;
    if !response.status().is_success() {
        return Err(format!("Image download failed with {}", response.status()));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(provider_network_error)?
        .to_vec();
    if bytes.len() > 25 * 1024 * 1024 {
        return Err("Downloaded image exceeds 25 MB".to_string());
    }
    Ok(bytes)
}

fn is_disallowed_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            ip.is_loopback() || ip.is_private() || ip.is_link_local() || ip.is_unspecified()
        }
        IpAddr::V6(ip) => ip.is_loopback() || ip.is_unspecified(),
    }
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

fn parse_image_size(size: &str) -> Result<(u32, u32), String> {
    let (width, height) = size
        .split_once('x')
        .ok_or_else(|| "Image size must use WIDTHxHEIGHT".to_string())?;
    let width = width
        .parse::<u32>()
        .map_err(|_| "Invalid image width".to_string())?
        .clamp(256, 2048);
    let height = height
        .parse::<u32>()
        .map_err(|_| "Invalid image height".to_string())?
        .clamp(256, 2048);
    Ok((width - width % 8, height - height % 8))
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

async fn request_embeddings(
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
        .ok_or_else(|| "Embedding response has no data".to_string())?
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

fn cosine_similarity(left: &[f32], right: &[f32]) -> Option<f64> {
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

fn validate_public_url(url: &reqwest::Url) -> Result<(), String> {
    if !matches!(url.scheme(), "http" | "https") {
        return Err("Research sources must use HTTP or HTTPS".to_string());
    }
    let host = url
        .host_str()
        .ok_or_else(|| "Research URL has no host".to_string())?;
    if host.eq_ignore_ascii_case("localhost")
        || host.parse::<IpAddr>().is_ok_and(is_disallowed_ip)
    {
        return Err("Research URL resolves to a local/private host".to_string());
    }
    Ok(())
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
}
