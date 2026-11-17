use crate::{safe_identifier, storage};
use percent_encoding::percent_decode_str;
use std::{
    fs::{self, File},
    io::{Read, Seek, SeekFrom},
    path::Path,
};
use tauri::http::{
    header::{
        ACCEPT_RANGES, ACCESS_CONTROL_ALLOW_HEADERS, ACCESS_CONTROL_ALLOW_METHODS,
        ACCESS_CONTROL_ALLOW_ORIGIN, ACCESS_CONTROL_EXPOSE_HEADERS, CACHE_CONTROL, CONTENT_LENGTH,
        CONTENT_RANGE, CONTENT_TYPE, RANGE,
    },
    HeaderValue, Method, Request, Response, StatusCode,
};

const ASSET_CACHE_CONTROL: &str = "private, max-age=0, must-revalidate";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ByteRange {
    /// Inclusive first byte.
    start: u64,
    /// Inclusive last byte.
    end: u64,
}

impl ByteRange {
    fn len(self) -> u64 {
        self.end.saturating_sub(self.start).saturating_add(1)
    }
}

#[derive(Debug, PartialEq, Eq)]
enum ParsedRange {
    None,
    Partial(ByteRange),
    Unsatisfiable,
}

fn text_response(status: StatusCode, body: &'static str) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(CONTENT_TYPE, "text/plain; charset=utf-8")
        .header(CACHE_CONTROL, "no-store")
        .header(ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(body.as_bytes().to_vec())
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

/// The application only supports media containers that the importer or
/// storage layer can create. Keep this table centralized so direct protocol
/// playback cannot disagree with the file extension written to disk.
pub(crate) fn mime_for_asset_path(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "svg" | "svgz" => "image/svg+xml",
        "png" => "image/png",
        "apng" => "image/apng",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "avif" => "image/avif",
        "bmp" => "image/bmp",
        "tif" | "tiff" => "image/tiff",
        "ico" => "image/x-icon",
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "ogv" => "video/ogg",
        "wav" => "audio/wav",
        "mp3" => "audio/mpeg",
        "m4a" => "audio/mp4",
        "aac" => "audio/aac",
        "flac" => "audio/flac",
        "ogg" | "opus" => "audio/ogg",
        "json" => "application/json; charset=utf-8",
        "txt" | "md" => "text/plain; charset=utf-8",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        _ => "application/octet-stream",
    }
}

fn parse_single_range(value: Option<&HeaderValue>, length: u64) -> ParsedRange {
    let Some(value) = value.and_then(|value| value.to_str().ok()) else {
        return ParsedRange::None;
    };
    let Some((unit, specification)) = value.trim().split_once('=') else {
        return ParsedRange::Unsatisfiable;
    };
    if !unit.eq_ignore_ascii_case("bytes") {
        return ParsedRange::Unsatisfiable;
    }
    if specification.trim().is_empty() || specification.contains(',') {
        return ParsedRange::Unsatisfiable;
    }
    let Some((raw_start, raw_end)) = specification.split_once('-') else {
        return ParsedRange::Unsatisfiable;
    };
    if raw_start.trim().is_empty() {
        let Ok(suffix_length) = raw_end.trim().parse::<u64>() else {
            return ParsedRange::Unsatisfiable;
        };
        if suffix_length == 0 || length == 0 {
            return ParsedRange::Unsatisfiable;
        }
        return ParsedRange::Partial(ByteRange {
            start: length.saturating_sub(suffix_length),
            end: length - 1,
        });
    }

    let Ok(start) = raw_start.trim().parse::<u64>() else {
        return ParsedRange::Unsatisfiable;
    };
    if start >= length {
        return ParsedRange::Unsatisfiable;
    }
    let end = if raw_end.trim().is_empty() {
        length.saturating_sub(1)
    } else {
        let Ok(requested_end) = raw_end.trim().parse::<u64>() else {
            return ParsedRange::Unsatisfiable;
        };
        if requested_end < start {
            return ParsedRange::Unsatisfiable;
        }
        requested_end.min(length.saturating_sub(1))
    };
    ParsedRange::Partial(ByteRange { start, end })
}

fn read_range(path: &Path, range: ByteRange) -> Result<Vec<u8>, String> {
    let mut file = File::open(path).map_err(|error| error.to_string())?;
    file.seek(SeekFrom::Start(range.start))
        .map_err(|error| error.to_string())?;
    let expected = usize::try_from(range.len())
        .map_err(|_| "Requested byte range is too large for this platform".to_string())?;
    let mut body = Vec::with_capacity(expected);
    file.take(range.len())
        .read_to_end(&mut body)
        .map_err(|error| error.to_string())?;
    if body.len() != expected {
        return Err("Asset changed while the byte range was being read".to_string());
    }
    Ok(body)
}

fn response_for_file(request: &Request<Vec<u8>>, path: &Path) -> Response<Vec<u8>> {
    let metadata = match fs::metadata(path) {
        Ok(metadata) if metadata.is_file() => metadata,
        _ => return text_response(StatusCode::NOT_FOUND, "Asset not found"),
    };
    let length = metadata.len();
    let range = match parse_single_range(request.headers().get(RANGE), length) {
        ParsedRange::None => None,
        ParsedRange::Partial(range) => Some(range),
        ParsedRange::Unsatisfiable => {
            return Response::builder()
                .status(StatusCode::RANGE_NOT_SATISFIABLE)
                .header(CONTENT_RANGE, format!("bytes */{length}"))
                .header(ACCEPT_RANGES, "bytes")
                .header(CONTENT_TYPE, "text/plain; charset=utf-8")
                .header(CACHE_CONTROL, "no-store")
                .header(ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                .body(b"Requested byte range is not satisfiable".to_vec())
                .unwrap_or_else(|_| Response::new(Vec::new()));
        }
    };
    let status = if range.is_some() {
        StatusCode::PARTIAL_CONTENT
    } else {
        StatusCode::OK
    };
    let body_length = range.map_or(length, ByteRange::len);
    let body = if request.method() == Method::HEAD {
        Vec::new()
    } else {
        let read = match range {
            Some(range) => read_range(path, range),
            None => fs::read(path).map_err(|error| error.to_string()),
        };
        match read {
            Ok(bytes) => bytes,
            // Static messages avoid leaking host paths through the protocol.
            Err(_) => {
                return text_response(StatusCode::INTERNAL_SERVER_ERROR, "Asset could not be read")
            }
        }
    };
    let mut builder = Response::builder()
        .status(status)
        .header(CONTENT_TYPE, mime_for_asset_path(path))
        .header(CONTENT_LENGTH, body_length.to_string())
        .header(ACCEPT_RANGES, "bytes")
        .header(CACHE_CONTROL, ASSET_CACHE_CONTROL)
        .header(ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(
            ACCESS_CONTROL_EXPOSE_HEADERS,
            "Content-Range, Content-Length, Accept-Ranges",
        );
    if let Some(range) = range {
        builder = builder.header(
            CONTENT_RANGE,
            format!("bytes {}-{}/{length}", range.start, range.end),
        );
    }
    builder
        .body(body)
        .unwrap_or_else(|_| text_response(StatusCode::INTERNAL_SERVER_ERROR, "Response failed"))
}

pub(crate) fn serve_project_asset(
    projects_root: &Path,
    request: Request<Vec<u8>>,
) -> Response<Vec<u8>> {
    if request.method() == Method::OPTIONS {
        return Response::builder()
            .status(StatusCode::NO_CONTENT)
            .header(ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .header(ACCESS_CONTROL_ALLOW_METHODS, "GET, HEAD, OPTIONS")
            .header(ACCESS_CONTROL_ALLOW_HEADERS, "Range")
            .body(Vec::new())
            .unwrap_or_else(|_| Response::new(Vec::new()));
    }
    if request.method() != Method::GET && request.method() != Method::HEAD {
        return text_response(StatusCode::METHOD_NOT_ALLOWED, "Method is not allowed");
    }
    let path = request.uri().path().trim_start_matches('/');
    let Some((project_id, relative)) = path.split_once('/') else {
        return text_response(StatusCode::BAD_REQUEST, "Invalid project asset path");
    };
    if !safe_identifier(project_id) {
        return text_response(StatusCode::BAD_REQUEST, "Invalid project id");
    }
    let decoded = percent_decode_str(relative).decode_utf8_lossy();
    let Some(relative) = storage::safe_relative_path(&decoded) else {
        return text_response(StatusCode::BAD_REQUEST, "Invalid asset path");
    };
    if !relative.starts_with("assets/") {
        return text_response(
            StatusCode::BAD_REQUEST,
            "Only registered project assets are served",
        );
    }
    let project_root = projects_root.join(project_id);
    let requested = project_root.join(&relative);
    let Ok(root) = project_root.canonicalize() else {
        return text_response(StatusCode::BAD_REQUEST, "Project directory is unavailable");
    };
    let Ok(requested) = requested.canonicalize() else {
        return text_response(StatusCode::NOT_FOUND, "Asset not found");
    };
    if !requested.starts_with(&root) || !requested.is_file() {
        return text_response(
            StatusCode::BAD_REQUEST,
            "Asset path escapes the project directory",
        );
    }
    response_for_file(&request, &requested)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::tempdir;

    fn request(method: Method, range: Option<&str>) -> Request<Vec<u8>> {
        let mut builder = Request::builder()
            .method(method)
            .uri("kmasset://localhost/project/assets/videos/clip.webm");
        if let Some(range) = range {
            builder = builder.header(RANGE, range);
        }
        builder.body(Vec::new()).expect("request")
    }

    #[test]
    fn parses_closed_open_and_suffix_ranges() {
        assert_eq!(
            parse_single_range(Some(&HeaderValue::from_static("bytes=2-5")), 10),
            ParsedRange::Partial(ByteRange { start: 2, end: 5 })
        );
        assert_eq!(
            parse_single_range(Some(&HeaderValue::from_static("bytes=7-")), 10),
            ParsedRange::Partial(ByteRange { start: 7, end: 9 })
        );
        assert_eq!(
            parse_single_range(Some(&HeaderValue::from_static("bytes=-4")), 10),
            ParsedRange::Partial(ByteRange { start: 6, end: 9 })
        );
        assert_eq!(
            parse_single_range(Some(&HeaderValue::from_static("bytes=7-99")), 10),
            ParsedRange::Partial(ByteRange { start: 7, end: 9 })
        );
        assert_eq!(
            parse_single_range(Some(&HeaderValue::from_static("Bytes=1-1")), 10),
            ParsedRange::Partial(ByteRange { start: 1, end: 1 })
        );
    }

    #[test]
    fn rejects_multiple_or_impossible_ranges() {
        for value in [
            "bytes=0-1,3-4",
            "bytes=10-",
            "bytes=5-4",
            "bytes=-0",
            "chars=0-1",
        ] {
            assert!(matches!(
                parse_single_range(
                    Some(&HeaderValue::from_static(
                        // HeaderValue::from_static requires 'static values, so the
                        // loop above deliberately exercises only static strings.
                        match value {
                            "bytes=0-1,3-4" => "bytes=0-1,3-4",
                            "bytes=10-" => "bytes=10-",
                            "bytes=5-4" => "bytes=5-4",
                            "bytes=-0" => "bytes=-0",
                            _ => "chars=0-1",
                        }
                    )),
                    10
                ),
                ParsedRange::Unsatisfiable
            ));
        }
    }

    #[test]
    fn serves_webm_with_206_and_complete_mime() {
        let directory = tempdir().expect("temporary directory");
        let path = directory.path().join("clip.webm");
        let mut file = File::create(&path).expect("video");
        file.write_all(b"0123456789").expect("video bytes");
        let response = response_for_file(&request(Method::GET, Some("bytes=2-5")), &path);
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(
            response
                .headers()
                .get(CONTENT_TYPE)
                .and_then(|value| value.to_str().ok()),
            Some("video/webm")
        );
        assert_eq!(
            response
                .headers()
                .get(CONTENT_RANGE)
                .and_then(|value| value.to_str().ok()),
            Some("bytes 2-5/10")
        );
        assert_eq!(response.body().as_slice(), b"2345");
    }

    #[test]
    fn maps_every_importable_media_mime_type() {
        for (name, mime) in [
            ("clip.mp4", "video/mp4"),
            ("clip.m4v", "video/mp4"),
            ("clip.webm", "video/webm"),
            ("clip.mov", "video/quicktime"),
            ("clip.ogv", "video/ogg"),
            ("voice.wav", "audio/wav"),
            ("voice.mp3", "audio/mpeg"),
            ("still.webp", "image/webp"),
            ("still.svg", "image/svg+xml"),
        ] {
            assert_eq!(mime_for_asset_path(Path::new(name)), mime);
        }
    }

    #[test]
    fn head_returns_metadata_without_reading_the_body() {
        let directory = tempdir().expect("temporary directory");
        let path = directory.path().join("clip.mov");
        fs::write(&path, b"abcdef").expect("video");
        let response = response_for_file(&request(Method::HEAD, None), &path);
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response
                .headers()
                .get(CONTENT_TYPE)
                .and_then(|value| value.to_str().ok()),
            Some("video/quicktime")
        );
        assert_eq!(
            response
                .headers()
                .get(CONTENT_LENGTH)
                .and_then(|value| value.to_str().ok()),
            Some("6")
        );
        assert!(response.body().is_empty());
    }

    #[test]
    fn unsatisfiable_range_reports_total_length() {
        let directory = tempdir().expect("temporary directory");
        let path = directory.path().join("clip.ogv");
        fs::write(&path, b"abc").expect("video");
        let response = response_for_file(&request(Method::GET, Some("bytes=8-")), &path);
        assert_eq!(response.status(), StatusCode::RANGE_NOT_SATISFIABLE);
        assert_eq!(
            response
                .headers()
                .get(CONTENT_RANGE)
                .and_then(|value| value.to_str().ok()),
            Some("bytes */3")
        );
    }

    #[test]
    fn project_route_serves_only_registered_asset_prefix() {
        let directory = tempdir().expect("projects directory");
        let video = directory.path().join("project-1/assets/videos/clip.webm");
        fs::create_dir_all(video.parent().expect("video parent")).expect("asset directories");
        fs::write(&video, b"0123456789").expect("video");
        let request = Request::builder()
            .method(Method::GET)
            .uri("kmasset://localhost/project-1/assets/videos/clip.webm")
            .header(RANGE, "bytes=4-7")
            .body(Vec::new())
            .expect("request");
        let response = serve_project_asset(directory.path(), request);
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(response.body().as_slice(), b"4567");

        let forbidden = Request::builder()
            .method(Method::GET)
            .uri("kmasset://localhost/project-1/project.json")
            .body(Vec::new())
            .expect("request");
        assert_eq!(
            serve_project_asset(directory.path(), forbidden).status(),
            StatusCode::BAD_REQUEST
        );
    }
}
