use crate::write_atomic;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use chrono::Utc;
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    time::{Duration, SystemTime},
};

const MAX_EMBEDDED_ASSET_BYTES: usize = 25 * 1024 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MissingAsset {
    pub asset_id: String,
    pub source: String,
}

pub(crate) struct ProjectLock {
    path: PathBuf,
}

impl ProjectLock {
    pub(crate) fn acquire(project_root: &Path) -> Result<Self, String> {
        fs::create_dir_all(project_root).map_err(|error| error.to_string())?;
        let path = project_root.join(".lock");
        for attempt in 0..2 {
            match OpenOptions::new().write(true).create_new(true).open(&path) {
                Ok(mut file) => {
                    writeln!(
                        file,
                        "pid={}\ncreated_at={}",
                        std::process::id(),
                        Utc::now().to_rfc3339()
                    )
                    .map_err(|error| error.to_string())?;
                    return Ok(Self { path });
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists && attempt == 0 => {
                    let stale = fs::metadata(&path)
                        .and_then(|metadata| metadata.modified())
                        .ok()
                        .and_then(|modified| SystemTime::now().duration_since(modified).ok())
                        .is_some_and(|age| age > Duration::from_secs(15 * 60));
                    if stale {
                        fs::remove_file(&path).map_err(|error| error.to_string())?;
                    } else {
                        return Err(
                            "Project is busy in another operation; retry after it finishes."
                                .to_string(),
                        );
                    }
                }
                Err(error) => return Err(format!("Unable to lock project: {error}")),
            }
        }
        Err("Unable to acquire project lock".to_string())
    }
}

impl Drop for ProjectLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

pub(crate) fn normalize_project_assets(
    projects_root: &Path,
    project: &Value,
) -> Result<Value, String> {
    let project_id = project
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| "Project is missing an id".to_string())?;
    let project_root = projects_root.join(project_id);
    let _lock = ProjectLock::acquire(&project_root)?;
    fs::create_dir_all(project_root.join("assets/images")).map_err(|error| error.to_string())?;
    fs::create_dir_all(project_root.join("assets/audio")).map_err(|error| error.to_string())?;

    let mut normalized = project.clone();
    let mut manifest = Vec::new();
    if let Some(assets) = normalized.get_mut("assets").and_then(Value::as_array_mut) {
        for asset in assets {
            let asset_id = asset
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            if !safe_component(&asset_id) {
                continue;
            }
            let source = asset
                .get("src")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let (relative_path, mime_type, bytes, sha256, status) =
                materialize_asset(&project_root, project_id, &asset_id, asset, &source)?;
            asset["src"] = Value::String(relative_path.clone());
            let record = json!({
                "assetId": asset_id,
                "sceneId": asset.get("sceneId"),
                "name": asset.get("name"),
                "kind": asset.get("kind"),
                "relativePath": relative_path,
                "mimeType": mime_type,
                "sha256": sha256,
                "bytes": bytes,
                "status": status,
                "prompt": asset.get("prompt"),
                "createdAt": asset.get("createdAt")
            });
            manifest.push(record);
        }
    }
    let project_root = projects_root.join(project_id);
    write_atomic(
        &project_root.join("assets/manifest.json"),
        &serde_json::to_vec_pretty(&manifest).map_err(|error| error.to_string())?,
    )?;
    write_snapshot(&project_root, &normalized)?;
    Ok(normalized)
}

fn materialize_asset(
    project_root: &Path,
    project_id: &str,
    asset_id: &str,
    asset: &Value,
    source: &str,
) -> Result<(String, String, i64, String, String), String> {
    if let Some(data_url) = source.strip_prefix("data:") {
        let (header, encoded) = data_url
            .split_once(',')
            .ok_or_else(|| format!("Asset {asset_id} contains a malformed data URL"))?;
        if encoded.len() > MAX_EMBEDDED_ASSET_BYTES * 2 {
            return Err(format!("Asset {asset_id} exceeds the 25 MB limit"));
        }
        let mime_type = header
            .strip_suffix(";base64")
            .ok_or_else(|| format!("Asset {asset_id} must use base64 data encoding"))?;
        let bytes = BASE64
            .decode(encoded)
            .map_err(|error| format!("Asset {asset_id} is not valid base64: {error}"))?;
        if bytes.is_empty() || bytes.len() > MAX_EMBEDDED_ASSET_BYTES {
            return Err(format!("Asset {asset_id} has an invalid file size"));
        }
        let is_audio = asset.get("kind").and_then(Value::as_str) == Some("audio");
        let mime_type = if is_audio {
            validate_audio_mime(mime_type, &bytes)?
        } else {
            validate_image_mime(mime_type, &bytes)?
        };
        let extension = extension_for_mime(mime_type);
        let directory = if is_audio {
            "assets/audio"
        } else {
            "assets/images"
        };
        let relative_path = format!("{directory}/{asset_id}.{extension}");
        let absolute = project_root.join(&relative_path);
        write_atomic(&absolute, &bytes)?;
        return Ok((
            relative_path,
            mime_type.to_string(),
            bytes.len() as i64,
            file_sha256(&absolute)?,
            "ready".to_string(),
        ));
    }

    if let Some((source_project_id, relative_path)) = parse_client_url(source) {
        let safe = safe_relative_path(&relative_path)
            .ok_or_else(|| format!("Asset {asset_id} contains an unsafe path"))?;
        if source_project_id != project_id {
            let projects_root = project_root
                .parent()
                .ok_or_else(|| "Project root is unavailable".to_string())?;
            let source_path = projects_root.join(&source_project_id).join(&safe);
            let bytes = fs::read(&source_path)
                .map_err(|error| format!("Unable to copy duplicated asset: {error}"))?;
            write_atomic(&project_root.join(&safe), &bytes)?;
        }
        let destination = project_root.join(&safe);
        let exists = destination.is_file();
        return Ok((
            safe,
            mime_for_path(&destination).to_string(),
            fs::metadata(&destination)
                .map(|metadata| metadata.len() as i64)
                .unwrap_or(0),
            if exists {
                file_sha256(&destination)?
            } else {
                String::new()
            },
            if exists { "ready" } else { "missing" }.to_string(),
        ));
    }
    let relative_path = client_url_to_relative(project_id, source).unwrap_or(source.to_string());
    if relative_path.starts_with("http://")
        || relative_path.starts_with("https://")
        || relative_path.starts_with("blob:")
    {
        return Ok((
            relative_path,
            asset
                .get("mimeType")
                .and_then(Value::as_str)
                .unwrap_or("application/octet-stream")
                .to_string(),
            0,
            String::new(),
            "external".to_string(),
        ));
    }
    let relative_path = safe_relative_path(&relative_path)
        .ok_or_else(|| format!("Asset {asset_id} contains an unsafe path"))?;
    let absolute = project_root.join(&relative_path);
    if !absolute.is_file() {
        return Ok((
            relative_path,
            "application/octet-stream".to_string(),
            0,
            String::new(),
            "missing".to_string(),
        ));
    }
    let bytes = fs::metadata(&absolute)
        .map_err(|error| error.to_string())?
        .len();
    let mime_type = mime_for_path(&absolute);
    Ok((
        relative_path,
        mime_type.to_string(),
        bytes as i64,
        file_sha256(&absolute)?,
        "ready".to_string(),
    ))
}

fn write_snapshot(project_root: &Path, project: &Value) -> Result<(), String> {
    let revision = Utc::now().format("%Y%m%dT%H%M%S%.3fZ").to_string();
    let snapshot = project_root.join("revisions").join(revision);
    for (relative, key) in [
        ("script/outline.json", "outline"),
        ("storyboard/scenes.json", "scenes"),
        ("animation/timeline.json", "timeline"),
        ("subtitles/captions.json", "subtitles"),
        ("assets/manifest.json", "assets"),
    ] {
        let destination = snapshot.join(relative);
        if relative == "assets/manifest.json" {
            continue;
        }
        let value = project
            .get(key)
            .cloned()
            .unwrap_or_else(|| Value::Array(Vec::new()));
        write_atomic(
            &destination,
            &serde_json::to_vec_pretty(&value).map_err(|error| error.to_string())?,
        )?;
    }
    Ok(())
}

pub(crate) fn scan_missing_assets(
    projects_root: &Path,
    project: &Value,
) -> Result<Vec<MissingAsset>, String> {
    let project_id = project
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| "Project is missing an id".to_string())?;
    let project_root = projects_root.join(project_id);
    let mut missing = Vec::new();
    if let Some(assets) = project.get("assets").and_then(Value::as_array) {
        for asset in assets {
            let asset_id = asset
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or("unknown")
                .to_string();
            let source = asset
                .get("src")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if source.starts_with("data:") {
                continue;
            }
            let relative = if let Some((_, relative)) = parse_client_url(source) {
                relative
            } else if source.starts_with("http://") || source.starts_with("https://") {
                continue;
            } else {
                source.to_string()
            };
            let Some(relative) = safe_relative_path(&relative) else {
                missing.push(MissingAsset {
                    asset_id,
                    source: source.to_string(),
                });
                continue;
            };
            if !project_root.join(relative).is_file() {
                missing.push(MissingAsset {
                    asset_id,
                    source: source.to_string(),
                });
            }
        }
    }
    Ok(missing)
}

pub(crate) fn persist_generated_image(
    projects_root: &Path,
    project_id: &str,
    asset_id: &str,
    bytes: &[u8],
    declared_mime: &str,
) -> Result<(String, String, String), String> {
    if !safe_component(asset_id) {
        return Err("Invalid generated asset id".to_string());
    }
    if bytes.is_empty() || bytes.len() > MAX_EMBEDDED_ASSET_BYTES {
        return Err("Generated image has an invalid file size".to_string());
    }
    let mime_type = validate_image_mime(declared_mime, bytes)?;
    let extension = extension_for_mime(mime_type);
    let project_root = projects_root.join(project_id);
    let relative_path = format!("assets/images/{asset_id}.{extension}");
    let absolute = project_root.join(&relative_path);
    write_atomic(&absolute, bytes)?;
    Ok((
        relative_path,
        mime_type.to_string(),
        file_sha256(&absolute)?,
    ))
}

pub(crate) fn persist_generated_audio(
    projects_root: &Path,
    project_id: &str,
    asset_id: &str,
    bytes: &[u8],
    declared_mime: &str,
) -> Result<(String, String, String), String> {
    if !safe_component(asset_id) {
        return Err("Invalid generated audio asset id".to_string());
    }
    if bytes.is_empty() || bytes.len() > MAX_EMBEDDED_ASSET_BYTES {
        return Err("Generated audio has an invalid file size".to_string());
    }
    let mime_type = validate_audio_mime(declared_mime, bytes)?;
    let extension = extension_for_mime(mime_type);
    let project_root = projects_root.join(project_id);
    let relative_path = format!("assets/audio/{asset_id}.{extension}");
    let absolute = project_root.join(&relative_path);
    write_atomic(&absolute, bytes)?;
    Ok((
        relative_path,
        mime_type.to_string(),
        file_sha256(&absolute)?,
    ))
}

pub(crate) fn archive_project(
    projects_root: &Path,
    project_id: &str,
) -> Result<Option<PathBuf>, String> {
    if !safe_component(project_id) {
        return Err("Invalid project id".to_string());
    }
    let source = projects_root.join(project_id);
    if !source.exists() {
        return Ok(None);
    }
    let archive_root = projects_root.join(".archive");
    fs::create_dir_all(&archive_root).map_err(|error| error.to_string())?;
    let destination = archive_root.join(format!(
        "{project_id}-{}",
        Utc::now().format("%Y%m%d-%H%M%S")
    ));
    fs::rename(&source, &destination).map_err(|error| {
        format!(
            "Unable to move deleted project to recoverable archive {}: {error}",
            destination.display()
        )
    })?;
    Ok(Some(destination))
}

pub(crate) fn create_project_zip(
    projects_root: &Path,
    project_id: &str,
    output: &Path,
) -> Result<(), String> {
    let project_root = projects_root.join(project_id);
    let project_text = fs::read_to_string(project_root.join("project.json"))
        .map_err(|error| format!("Project manifest is unavailable: {error}"))?;
    let project: Value = serde_json::from_str(&project_text)
        .map_err(|error| format!("Project manifest is invalid: {error}"))?;
    let missing = scan_missing_assets(projects_root, &project)?;
    if !missing.is_empty() {
        return Err(format!(
            "Project package cannot be exported because {} asset references are missing",
            missing.len()
        ));
    }

    let temporary = output.with_extension("zip.partial");
    let file = File::create(&temporary).map_err(|error| error.to_string())?;
    let mut writer = ZipWriter::new(file);
    let mut files = Vec::new();
    collect_package_files(&project_root, &project_root, &mut files)?;
    files.sort();
    for file_path in files {
        let relative = file_path
            .strip_prefix(&project_root)
            .map_err(|error| error.to_string())?
            .to_string_lossy()
            .replace('\\', "/");
        let data = fs::read(&file_path).map_err(|error| error.to_string())?;
        writer.add_file(&relative, &data)?;
    }
    writer.finish()?;
    fs::rename(&temporary, output).map_err(|error| error.to_string())
}

pub(crate) fn import_project_zip(
    projects_root: &Path,
    package_path: &Path,
) -> Result<(String, Value), String> {
    let bytes = fs::read(package_path)
        .map_err(|error| format!("Unable to read project package: {error}"))?;
    let entries = read_zip_entries(&bytes)?;
    let has_manifest = entries
        .iter()
        .any(|entry| entry.name == "project.json" && !entry.is_directory);
    if !has_manifest {
        return Err("ZIP package does not contain project.json".to_string());
    }
    let temporary = projects_root.join(format!(".import-{}", uuid::Uuid::new_v4().simple()));
    fs::create_dir_all(&temporary).map_err(|error| error.to_string())?;
    let extraction_result = (|| -> Result<(String, Value), String> {
        for entry in entries {
            let relative = safe_relative_path(&entry.name)
                .ok_or_else(|| format!("Unsafe ZIP entry path: {}", entry.name))?;
            let destination = temporary.join(&relative);
            if entry.is_directory {
                fs::create_dir_all(&destination).map_err(|error| error.to_string())?;
                continue;
            }
            if let Some(parent) = destination.parent() {
                fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            }
            write_atomic(&destination, &entry.data)?;
        }
        let mut project: Value = serde_json::from_slice(
            &fs::read(temporary.join("project.json"))
                .map_err(|error| format!("Invalid project manifest: {error}"))?,
        )
        .map_err(|error| format!("Invalid project manifest: {error}"))?;
        let new_id = format!("project_{}", uuid::Uuid::new_v4().simple());
        let title = project
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or("Imported project")
            .to_string();
        project["id"] = Value::String(new_id.clone());
        project["title"] = Value::String(format!("{title} · 导入"));
        project["isDemo"] = Value::Bool(false);
        project["updatedAt"] = Value::String(Utc::now().to_rfc3339());
        write_atomic(
            &temporary.join("project.json"),
            &serde_json::to_vec_pretty(&project).map_err(|error| error.to_string())?,
        )?;
        fs::rename(&temporary, projects_root.join(&new_id))
            .map_err(|error| format!("Unable to commit imported project: {error}"))?;
        Ok((new_id, project))
    })();
    if extraction_result.is_err() {
        let _ = fs::remove_dir_all(&temporary);
    }
    extraction_result
}

fn collect_package_files(root: &Path, current: &Path, files: &mut Vec<PathBuf>) -> Result<(), String> {
    for entry in fs::read_dir(current).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        let name = entry.file_name();
        if path.is_dir() {
            if name == "cache" || name == ".lock" {
                continue;
            }
            collect_package_files(root, &path, files)?;
        } else if name != ".lock" {
            files.push(path);
        }
    }
    Ok(())
}

pub(crate) fn file_sha256(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|error| error.to_string())?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 1024 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex::encode(hasher.finalize()))
}

pub(crate) fn client_url_to_relative(project_id: &str, source: &str) -> Option<String> {
    parse_client_url(source)
        .filter(|(source_project_id, _)| source_project_id == project_id)
        .map(|(_, relative)| relative)
}

pub(crate) fn public_asset_source(project_id: &str, relative: &str) -> String {
    let encoded = relative
        .split('/')
        .map(|segment| utf8_percent_encode(segment))
        .collect::<Vec<_>>()
        .join("/");
    #[cfg(windows)]
    {
        format!("http://kmasset.localhost/{project_id}/{encoded}")
    }
    #[cfg(not(windows))]
    {
        format!("kmasset://localhost/{project_id}/{encoded}")
    }
}

fn utf8_percent_encode(value: &str) -> String {
    value
        .bytes()
        .map(|byte| {
            if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
                (byte as char).to_string()
            } else {
                format!("%{byte:02X}")
            }
        })
        .collect()
}

fn parse_client_url(source: &str) -> Option<(String, String)> {
    let rest = source
        .strip_prefix("http://kmasset.localhost/")
        .or_else(|| source.strip_prefix("kmasset://localhost/"))?;
    let (project_id, relative) = rest.split_once('/')?;
    Some((project_id.to_string(), percent_decode_path(relative)))
}

fn percent_decode_path(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let Ok(hex) = std::str::from_utf8(&bytes[index + 1..index + 3])
                .ok()
                .and_then(|hex| u8::from_str_radix(hex, 16).ok())
                .ok_or(())
            {
                output.push(hex);
                index += 3;
                continue;
            }
        }
        output.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&output).to_string()
}

pub(crate) fn safe_relative_path(value: &str) -> Option<String> {
    let path = Path::new(value);
    if path.is_absolute()
        || path
            .components()
            .any(|component| matches!(component, Component::ParentDir | Component::Prefix(_)))
    {
        return None;
    }
    let normalized = path
        .components()
        .filter_map(|component| match component {
            Component::Normal(value) => Some(value.to_string_lossy().to_string()),
            Component::CurDir => None,
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/");
    (!normalized.is_empty()).then_some(normalized)
}

fn safe_component(value: &str) -> bool {
    !value.is_empty()
        && value != "."
        && value != ".."
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
}

fn validate_image_mime<'a>(declared: &'a str, bytes: &[u8]) -> Result<&'a str, String> {
    let detected = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        "image/png"
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        "image/jpeg"
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        "image/webp"
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        "image/gif"
    } else if std::str::from_utf8(bytes)
        .ok()
        .is_some_and(|text| text.trim_start().starts_with("<svg"))
    {
        "image/svg+xml"
    } else {
        return Err("Embedded asset is not a supported image format".to_string());
    };
    if declared != detected {
        return Err(format!(
            "Asset MIME type {declared} does not match its file signature"
        ));
    }
    Ok(detected)
}

fn validate_audio_mime<'a>(declared: &'a str, bytes: &[u8]) -> Result<&'a str, String> {
    let detected = if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WAVE") {
        "audio/wav"
    } else if bytes.starts_with(b"ID3") || bytes.get(0..2) == Some(&[0xff, 0xfb]) {
        "audio/mpeg"
    } else {
        return Err("Embedded audio is not a supported WAV or MP3 file".to_string());
    };
    if declared != detected {
        return Err(format!(
            "Asset MIME type {declared} does not match its file signature"
        ));
    }
    Ok(detected)
}

fn extension_for_mime(mime: &str) -> &'static str {
    match mime {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/webp" => "webp",
        "image/gif" => "gif",
        "audio/wav" => "wav",
        "audio/mpeg" => "mp3",
        _ => "svg",
    }
}

fn mime_for_path(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "wav" => "audio/wav",
        "mp3" => "audio/mpeg",
        "mp4" => "video/mp4",
        _ => "application/octet-stream",
    }
}

struct ZipWriter<W: Write> {
    writer: W,
    entries: Vec<ZipEntry>,
    offset: u64,
}

#[derive(Clone)]
struct ZipEntry {
    name: Vec<u8>,
    crc32: u32,
    size: u32,
    offset: u32,
}

impl<W: Write> ZipWriter<W> {
    fn new(writer: W) -> Self {
        Self {
            writer,
            entries: Vec::new(),
            offset: 0,
        }
    }

    fn add_file(&mut self, name: &str, data: &[u8]) -> Result<(), String> {
        let size = u32::try_from(data.len())
            .map_err(|_| "Project contains a file larger than 4 GB".to_string())?;
        let name_bytes = name.as_bytes();
        let name_len =
            u16::try_from(name_bytes.len()).map_err(|_| "ZIP path is too long".to_string())?;
        let crc32 = crc32(data);
        let offset =
            u32::try_from(self.offset).map_err(|_| "Project ZIP exceeds 4 GB".to_string())?;
        self.write_u32(0x0403_4b50)?;
        self.write_u16(20)?;
        self.write_u16(0)?;
        self.write_u16(0)?;
        self.write_u16(0)?;
        self.write_u16(0)?;
        self.write_u32(crc32)?;
        self.write_u32(size)?;
        self.write_u32(size)?;
        self.write_u16(name_len)?;
        self.write_u16(0)?;
        self.write_all(name_bytes)?;
        self.write_all(data)?;
        self.entries.push(ZipEntry {
            name: name_bytes.to_vec(),
            crc32,
            size,
            offset,
        });
        Ok(())
    }

    fn finish(mut self) -> Result<(), String> {
        let central_start =
            u32::try_from(self.offset).map_err(|_| "Project ZIP exceeds 4 GB".to_string())?;
        let entries = self.entries.clone();
        for entry in &entries {
            self.write_u32(0x0201_4b50)?;
            self.write_u16(20)?;
            self.write_u16(20)?;
            self.write_u16(0)?;
            self.write_u16(0)?;
            self.write_u16(0)?;
            self.write_u16(0)?;
            self.write_u32(entry.crc32)?;
            self.write_u32(entry.size)?;
            self.write_u32(entry.size)?;
            self.write_u16(entry.name.len() as u16)?;
            self.write_u16(0)?;
            self.write_u16(0)?;
            self.write_u16(0)?;
            self.write_u16(0)?;
            self.write_u32(0)?;
            self.write_u32(entry.offset)?;
            self.write_all(&entry.name)?;
        }
        let central_end =
            u32::try_from(self.offset).map_err(|_| "Project ZIP exceeds 4 GB".to_string())?;
        let central_size = central_end
            .checked_sub(central_start)
            .ok_or_else(|| "Invalid ZIP central directory".to_string())?;
        let count = u16::try_from(self.entries.len())
            .map_err(|_| "Project contains too many files".to_string())?;
        self.write_u32(0x0605_4b50)?;
        self.write_u16(0)?;
        self.write_u16(0)?;
        self.write_u16(count)?;
        self.write_u16(count)?;
        self.write_u32(central_size)?;
        self.write_u32(central_start)?;
        self.write_u16(0)?;
        self.writer.flush().map_err(|error| error.to_string())
    }

    fn write_u16(&mut self, value: u16) -> Result<(), String> {
        self.write_all(&value.to_le_bytes())
    }

    fn write_u32(&mut self, value: u32) -> Result<(), String> {
        self.write_all(&value.to_le_bytes())
    }

    fn write_all(&mut self, bytes: &[u8]) -> Result<(), String> {
        self.writer
            .write_all(bytes)
            .map_err(|error| error.to_string())?;
        self.offset += bytes.len() as u64;
        Ok(())
    }
}

fn crc32(bytes: &[u8]) -> u32 {
    let mut crc = 0xffff_ffff_u32;
    for byte in bytes {
        crc ^= u32::from(*byte);
        for _ in 0..8 {
            let mask = (crc & 1).wrapping_neg();
            crc = (crc >> 1) ^ (0xedb8_8320 & mask);
        }
    }
    !crc
}

struct ReadZipEntry {
    name: String,
    data: Vec<u8>,
    is_directory: bool,
}

fn read_zip_entries(bytes: &[u8]) -> Result<Vec<ReadZipEntry>, String> {
    let eocd = find_signature_reverse(bytes, 0x0605_4b50)
        .ok_or_else(|| "ZIP end-of-central-directory record is missing".to_string())?;
    if bytes.len() < eocd + 22 {
        return Err("ZIP end record is truncated".to_string());
    }
    let count = read_u16(bytes, eocd + 10)? as usize;
    let central_offset = read_u32(bytes, eocd + 16)? as usize;
    let mut cursor = central_offset;
    let mut entries = Vec::with_capacity(count);
    for _ in 0..count {
        if read_u32(bytes, cursor)? != 0x0201_4b50 {
            return Err("ZIP central directory entry is invalid".to_string());
        }
        let flags = read_u16(bytes, cursor + 8)?;
        let method = read_u16(bytes, cursor + 10)?;
        let expected_crc = read_u32(bytes, cursor + 16)?;
        let compressed_size = read_u32(bytes, cursor + 20)? as usize;
        let uncompressed_size = read_u32(bytes, cursor + 24)? as usize;
        let name_length = read_u16(bytes, cursor + 28)? as usize;
        let extra_length = read_u16(bytes, cursor + 30)? as usize;
        let comment_length = read_u16(bytes, cursor + 32)? as usize;
        let local_offset = read_u32(bytes, cursor + 42)? as usize;
        let name_start = cursor + 46;
        let name_end = name_start
            .checked_add(name_length)
            .filter(|end| *end <= bytes.len())
            .ok_or_else(|| "ZIP entry name is truncated".to_string())?;
        let name = String::from_utf8(bytes[name_start..name_end].to_vec())
            .map_err(|_| "ZIP entry name is not valid UTF-8".to_string())?;
        if flags & 1 != 0 {
            return Err(format!("Encrypted ZIP entry is not supported: {name}"));
        }
        if method != 0 {
            return Err(format!(
                "Only uncompressed KnowMotion ZIP entries are supported: {name}"
            ));
        }
        if compressed_size != uncompressed_size {
            return Err(format!("ZIP entry size mismatch: {name}"));
        }
        if read_u32(bytes, local_offset)? != 0x0403_4b50 {
            return Err(format!("ZIP local header is invalid: {name}"));
        }
        let local_name_length = read_u16(bytes, local_offset + 26)? as usize;
        let local_extra_length = read_u16(bytes, local_offset + 28)? as usize;
        let data_start = local_offset + 30 + local_name_length + local_extra_length;
        let data_end = data_start
            .checked_add(compressed_size)
            .filter(|end| *end <= bytes.len())
            .ok_or_else(|| format!("ZIP entry data is truncated: {name}"))?;
        let data = bytes[data_start..data_end].to_vec();
        if crc32(&data) != expected_crc {
            return Err(format!("ZIP checksum failed: {name}"));
        }
        entries.push(ReadZipEntry {
            is_directory: name.ends_with('/'),
            name,
            data,
        });
        cursor = name_end + extra_length + comment_length;
    }
    Ok(entries)
}

fn find_signature_reverse(bytes: &[u8], signature: u32) -> Option<usize> {
    let needle = signature.to_le_bytes();
    bytes
        .windows(4)
        .rposition(|window| window == needle)
}

fn read_u16(bytes: &[u8], offset: usize) -> Result<u16, String> {
    let value = bytes
        .get(offset..offset + 2)
        .ok_or_else(|| "ZIP data is truncated".to_string())?;
    Ok(u16::from_le_bytes([value[0], value[1]]))
}

fn read_u32(bytes: &[u8], offset: usize) -> Result<u32, String> {
    let value = bytes
        .get(offset..offset + 4)
        .ok_or_else(|| "ZIP data is truncated".to_string())?;
    Ok(u32::from_le_bytes([value[0], value[1], value[2], value[3]]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn materializes_data_url_and_writes_asset_manifest() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let project = json!({
            "id": "project-1",
            "assets": [{
                "id": "asset-1",
                "sceneId": "scene-1",
                "name": "draft.svg",
                "kind": "image",
                "src": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPjwvc3ZnPg==",
                "createdAt": "now"
            }]
        });
        let normalized =
            normalize_project_assets(directory.path(), &project).expect("normalize assets");
        assert_eq!(normalized["assets"][0]["src"], "assets/images/asset-1.svg");
        let asset_path = directory
            .path()
            .join("project-1/assets/images/asset-1.svg");
        assert!(asset_path.is_file());
        let manifest: Value = serde_json::from_str(
            &fs::read_to_string(directory.path().join("project-1/assets/manifest.json"))
                .expect("manifest"),
        )
        .expect("manifest JSON");
        assert_eq!(manifest[0]["status"], "ready");
        assert_eq!(manifest[0]["mimeType"], "image/svg+xml");
    }

    #[test]
    fn project_zip_contains_project_and_images() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let project_root = directory.path().join("project-1");
        fs::create_dir_all(project_root.join("assets/images")).expect("project dirs");
        fs::write(
            project_root.join("project.json"),
            r#"{"id":"project-1","assets":[]}"#,
        )
        .expect("project manifest");
        fs::write(project_root.join("assets/images/scene.svg"), b"<svg/>")
            .expect("asset");
        let output = directory.path().join("project.zip");
        create_project_zip(directory.path(), "project-1", &output).expect("zip");
        let bytes = fs::read(output).expect("zip bytes");
        assert!(bytes.starts_with(b"PK\x03\x04"));
        assert!(bytes.windows(14).any(|part| part == b"assets/images/"));
    }

    #[test]
    fn exported_project_zip_imports_as_a_new_project() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let projects_root = directory.path().join("projects");
        let project_root = projects_root.join("project-1");
        fs::create_dir_all(project_root.join("assets/images")).expect("project dirs");
        fs::write(
            project_root.join("project.json"),
            r#"{"id":"project-1","title":"Imported","assets":[]}"#,
        )
        .expect("project manifest");
        fs::write(project_root.join("assets/images/scene.svg"), b"<svg/>")
            .expect("asset");
        let output = directory.path().join("project.zip");
        create_project_zip(&projects_root, "project-1", &output).expect("zip");

        let (new_id, project) =
            import_project_zip(&projects_root, &output).expect("import project");

        assert_ne!(new_id, "project-1");
        assert!(projects_root
            .join(&new_id)
            .join("assets/images/scene.svg")
            .is_file());
        assert_eq!(project["id"], new_id);
    }

    #[test]
    fn crc32_matches_standard_vector() {
        assert_eq!(crc32(b"123456789"), 0xcbf4_3926);
    }
}
