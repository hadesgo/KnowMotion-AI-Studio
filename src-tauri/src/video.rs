use crate::{logging, logging::LogLevel, safe_identifier, storage::public_asset_source, AppState};
use chrono::Utc;
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    time::Instant,
};
use tauri::State;
use uuid::Uuid;

const MAX_VIDEO_BYTES: u64 = 128 * 1024 * 1024;

struct VideoFormat {
    extension: &'static str,
    mime: &'static str,
}

/// 只接受 Remotion / Chrome 能播放的容器；mov 常见 H.264，允许但由前端探测可解码性。
fn video_format(path: &Path, header: &[u8]) -> Result<VideoFormat, String> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let format = match extension.as_str() {
        "mp4" | "m4v" => VideoFormat {
            extension: "mp4",
            mime: "video/mp4",
        },
        "webm" => VideoFormat {
            extension: "webm",
            mime: "video/webm",
        },
        "mov" => VideoFormat {
            extension: "mov",
            mime: "video/quicktime",
        },
        "ogv" => VideoFormat {
            extension: "ogv",
            mime: "video/ogg",
        },
        other => {
            return Err(format!(
                "Unsupported video extension: .{other} (expected mp4, m4v, webm, mov or ogv)"
            ))
        }
    };
    let container_matches = match format.extension {
        "mp4" | "mov" => header.get(4..8) == Some(b"ftyp"),
        "webm" => header.starts_with(&[0x1a, 0x45, 0xdf, 0xa3]),
        "ogv" => header.starts_with(b"OggS"),
        _ => false,
    };
    if !container_matches {
        return Err("File content does not match its video container extension".to_string());
    }
    Ok(format)
}

fn validate_source(path: &Path) -> Result<(VideoFormat, u64), String> {
    let canonical = path
        .canonicalize()
        .map_err(|error| format!("Unable to open the selected video: {error}"))?;
    if !canonical.is_file() {
        return Err("The selected video path is not a file".to_string());
    }
    let metadata = fs::metadata(&canonical).map_err(|error| error.to_string())?;
    if metadata.len() == 0 {
        return Err("The selected video is empty".to_string());
    }
    if metadata.len() > MAX_VIDEO_BYTES {
        return Err("Video files are limited to 128 MiB".to_string());
    }
    use std::io::Read;
    let mut header = [0_u8; 16];
    let mut file = fs::File::open(&canonical).map_err(|error| error.to_string())?;
    let read = file.read(&mut header).map_err(|error| error.to_string())?;
    let format = video_format(&canonical, &header[..read])?;
    Ok((format, metadata.len()))
}

fn copy_into_project(source: &Path, destination: &Path) -> Result<(), String> {
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let temporary = destination.with_extension("tmp");
    fs::copy(source, &temporary)
        .map_err(|error| format!("Unable to copy the video into the project: {error}"))?;
    let copied = fs::metadata(&temporary).map_err(|error| error.to_string())?;
    if copied.len() == 0 {
        let _ = fs::remove_file(&temporary);
        return Err("Copied video is empty".to_string());
    }
    fs::rename(&temporary, destination)
        .map_err(|error| format!("Unable to commit the imported video: {error}"))?;
    Ok(())
}

#[tauri::command]
pub fn import_project_video(
    state: State<'_, AppState>,
    project_id: String,
    source_path: String,
    name: Option<String>,
) -> Result<Value, String> {
    if !safe_identifier(&project_id) {
        return Err("Invalid project id".to_string());
    }
    let source = PathBuf::from(source_path.trim());
    if source.as_os_str().is_empty() {
        return Err("No source video was selected".to_string());
    }
    let started = Instant::now();
    let (format, bytes) = validate_source(&source)?;
    let asset_id = format!("asset_{}", Uuid::new_v4().simple());
    let relative = format!("assets/videos/{asset_id}.{}", format.extension);
    let project_root = state.projects_root.join(&project_id);
    if !project_root.is_dir() {
        return Err("Project directory does not exist yet".to_string());
    }
    let destination = project_root.join(&relative);
    copy_into_project(&source, &destination)?;

    let file_name = source
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("video")
        .to_string();
    let asset_name = name
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or(file_name);
    let created_at = Utc::now().to_rfc3339();
    let asset = json!({
        "id": asset_id,
        "sceneId": "",
        "name": asset_name,
        "kind": "video",
        "src": public_asset_source(&project_id, &relative),
        "prompt": "用户导入视频",
        "createdAt": created_at,
        "local": true,
        "bytes": bytes,
        "mimeType": format.mime,
    });
    logging::log_event(
        LogLevel::Info,
        "media.video",
        "Video imported into project",
        Some(json!({
            "projectId": project_id,
            "assetId": asset_id,
            "bytes": bytes,
            "mime": format.mime,
            "elapsedMs": started.elapsed().as_millis()
        })),
    );
    Ok(asset)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_mp4_and_rejects_mismatched_container() {
        let format = video_format(Path::new("clip.mp4"), b"\x00\x00\x00\x18ftypisom").expect("mp4");
        assert_eq!(format.mime, "video/mp4");
        assert!(video_format(Path::new("clip.mp4"), b"not-a-video").is_err());
        assert!(video_format(Path::new("clip.avi"), b"RIFF....AVI ").is_err());
    }

    #[test]
    fn detects_webm_and_ogv_headers() {
        assert_eq!(
            video_format(Path::new("clip.webm"), &[0x1a, 0x45, 0xdf, 0xa3])
                .expect("webm")
                .extension,
            "webm"
        );
        assert_eq!(
            video_format(Path::new("clip.ogv"), b"OggS\x00\x02")
                .expect("ogv")
                .mime,
            "video/ogg"
        );
    }
}
