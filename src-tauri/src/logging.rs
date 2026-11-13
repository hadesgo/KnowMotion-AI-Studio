use chrono::Utc;
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::{
    fs::{self, File, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    sync::{
        mpsc::{self, Receiver, SyncSender},
        Mutex, MutexGuard, OnceLock,
    },
    thread,
    time::{Duration, SystemTime},
};

const MAX_RECORD_CHARS: usize = 64 * 1024;
const MAX_FIELD_CHARS: usize = 32 * 1024;
const DEFAULT_MAX_BYTES: u64 = 5 * 1024 * 1024;
const DEFAULT_MAX_ROTATED_FILES: usize = 7;
const MAX_LOG_AGE_DAYS: u64 = 30;
const LOG_FILE_NAME: &str = "knowmotion.log";

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum LogLevel {
    Trace,
    Debug,
    Info,
    Warn,
    Error,
}

impl LogLevel {
    pub(crate) fn parse(value: &str) -> Option<Self> {
        match value.to_ascii_lowercase().as_str() {
            "trace" => Some(Self::Trace),
            "debug" => Some(Self::Debug),
            "info" => Some(Self::Info),
            "warn" | "warning" => Some(Self::Warn),
            "error" => Some(Self::Error),
            _ => None,
        }
    }
}

#[derive(Debug, Serialize)]
struct LogRecord {
    timestamp: String,
    level: LogLevel,
    target: String,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    fields: Option<Value>,
}

enum LogCommand {
    Write(LogRecord),
    Flush(SyncSender<()>),
}

struct LoggerState {
    sender: SyncSender<LogCommand>,
    directory: PathBuf,
    writer: thread::JoinHandle<()>,
}

static LOGGER: OnceLock<Mutex<Option<LoggerState>>> = OnceLock::new();
static PANIC_HOOK: OnceLock<()> = OnceLock::new();

pub(crate) fn init(directory: &Path) -> Result<(), String> {
    fs::create_dir_all(directory).map_err(|error| error.to_string())?;
    let logger_slot = LOGGER.get_or_init(|| Mutex::new(None));
    let mut logger = lock(logger_slot)?;
    if logger.is_some() {
        return Ok(());
    }
    let directory = directory.to_path_buf();
    let writer_directory = directory.clone();
    let mut writer = RotatingFileWriter::new(
        &writer_directory,
        LOG_FILE_NAME,
        DEFAULT_MAX_BYTES,
        DEFAULT_MAX_ROTATED_FILES,
    )
    .map_err(|error| format!("Unable to open log file: {error}"))?;
    let (sender, receiver) = mpsc::sync_channel(2_048);
    let writer = thread::Builder::new()
        .name("knowmotion-log-writer".to_string())
        .spawn(move || {
            run_writer(receiver, &mut writer);
        })
        .map_err(|error| format!("Unable to start log writer: {error}"))?;
    *logger = Some(LoggerState {
        sender,
        directory,
        writer,
    });
    Ok(())
}

pub(crate) fn install_panic_hook() {
    PANIC_HOOK.get_or_init(|| {
        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            let location = info
                .location()
                .map(|location| {
                    format!("{}:{}:{}", location.file(), location.line(), location.column())
                })
                .unwrap_or_else(|| "unknown".to_string());
            let message = if let Some(message) = info.payload().downcast_ref::<&str>() {
                (*message).to_string()
            } else if let Some(message) = info.payload().downcast_ref::<String>() {
                message.clone()
            } else {
                "Non-string panic payload".to_string()
            };
            log_event(
                LogLevel::Error,
                "panic",
                "Unhandled panic",
                Some(json!({ "location": location, "panic": message })),
            );
            let _ = flush();
            previous(info);
        }));
    });
}

pub(crate) fn info(target: &str, message: &str) {
    log(LogLevel::Info, target, message);
}

pub(crate) fn log(level: LogLevel, target: &str, message: &str) {
    log_event(level, target, message, None);
}

pub(crate) fn log_event(
    level: LogLevel,
    target: &str,
    message: &str,
    fields: Option<Value>,
) {
    let record = prepare_record(level, target, message, fields);
    let Some(logger_slot) = LOGGER.get() else {
        return;
    };
    let Ok(logger) = logger_slot.lock() else {
        return;
    };
    let Some(state) = logger.as_ref() else {
        return;
    };
    match state.sender.try_send(LogCommand::Write(record)) {
        Ok(()) => {}
        Err(mpsc::TrySendError::Full(command))
            if matches!(level, LogLevel::Error | LogLevel::Warn) =>
        {
            let _ = state.sender.send(command);
        }
        Err(_) => {}
    }
}

pub(crate) fn flush() -> Result<(), String> {
    let Some(logger_slot) = LOGGER.get() else {
        return Ok(());
    };
    let logger = lock(logger_slot)?;
    let Some(state) = logger.as_ref() else {
        return Ok(());
    };
    let (ack_sender, ack_receiver) = mpsc::sync_channel(1);
    state
        .sender
        .send(LogCommand::Flush(ack_sender))
        .map_err(|_| "Log writer is unavailable".to_string())?;
    ack_receiver
        .recv_timeout(Duration::from_secs(2))
        .map_err(|_| "Timed out while flushing logs".to_string())
}

pub(crate) fn shutdown() {
    let _ = flush();
    let Some(logger_slot) = LOGGER.get() else {
        return;
    };
    let state = logger_slot.lock().ok().and_then(|mut logger| logger.take());
    if let Some(state) = state {
        drop(state.sender);
        let _ = state.writer.join();
    }
}

pub(crate) fn directory() -> Option<PathBuf> {
    LOGGER
        .get()
        .and_then(|logger| logger.lock().ok())
        .and_then(|logger| logger.as_ref().map(|state| state.directory.clone()))
}

pub(crate) fn healthy() -> bool {
    LOGGER
        .get()
        .and_then(|logger| logger.lock().ok())
        .and_then(|logger| logger.as_ref().map(|state| !state.writer.is_finished()))
        .unwrap_or(false)
}

fn lock<T>(mutex: &Mutex<T>) -> Result<MutexGuard<'_, T>, String> {
    mutex
        .lock()
        .map_err(|_| "Logging lock is unavailable".to_string())
}

fn run_writer(receiver: Receiver<LogCommand>, writer: &mut RotatingFileWriter) {
    while let Ok(command) = receiver.recv() {
        match command {
            LogCommand::Write(record) => {
                if let Ok(bytes) = serde_json::to_vec(&record) {
                    let _ = writer.write_line(&bytes).and_then(|_| writer.flush(false));
                }
            }
            LogCommand::Flush(ack) => {
                let _ = writer.flush(true);
                let _ = ack.send(());
            }
        }
    }
    let _ = writer.flush(true);
}

fn prepare_record(
    level: LogLevel,
    target: &str,
    message: &str,
    fields: Option<Value>,
) -> LogRecord {
    let message = truncate_chars(&redact_text(message), MAX_RECORD_CHARS);
    let fields = fields.map(|fields| {
        let redacted_fields = redact_json(fields);
        let serialized = redacted_fields.to_string();
        if serialized.chars().count() > MAX_FIELD_CHARS {
            json!({
                "truncated": true,
                "preview": truncate_chars(&serialized, MAX_FIELD_CHARS),
            })
        } else {
            redacted_fields
        }
    });
    LogRecord {
        timestamp: Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        level,
        target: truncate_chars(&redact_text(target), 160),
        message,
        fields,
    }
}

pub(crate) fn redact_text(input: &str) -> String {
    if input.is_empty() {
        return String::new();
    }
    let mut value = redact_private_key_blocks(input);
    value = redact_data_urls(&value);
    value = redact_url_userinfo(&value);
    value = redact_keyed_values(&value);
    value = redact_bearer_tokens(&value);
    redact_known_token_prefixes(&value)
}

pub(crate) fn redact_json(value: Value) -> Value {
    match value {
        Value::Object(object) => Value::Object(
            object
                .into_iter()
                .map(|(key, value)| {
                    let redacted = if sensitive_key(&key) {
                        Value::String("[REDACTED]".to_string())
                    } else {
                        redact_json(value)
                    };
                    (redact_text(&key), redacted)
                })
                .collect::<Map<_, _>>(),
        ),
        Value::Array(values) => {
            Value::Array(values.into_iter().map(redact_json).collect::<Vec<_>>())
        }
        Value::String(value) => Value::String(redact_text(&value)),
        other => other,
    }
}

fn sensitive_key(key: &str) -> bool {
    let normalized = key
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect::<String>();
    matches!(
        normalized.as_str(),
        "authorization"
            | "xapikey"
            | "apikey"
            | "secret"
            | "clientsecret"
            | "password"
            | "credential"
            | "credentialref"
            | "accesstoken"
            | "refreshtoken"
            | "authtoken"
            | "token"
            | "key"
            | "cookie"
            | "setcookie"
            | "prompt"
            | "input"
            | "messages"
            | "content"
            | "narration"
            | "script"
            | "requestbody"
            | "responsebody"
            | "request"
            | "response"
            | "document"
            | "toolinput"
            | "text"
    ) || normalized.ends_with("apikey")
        || normalized.ends_with("secret")
        || normalized.ends_with("password")
}

fn redact_private_key_blocks(input: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let mut cursor = 0;
    while let Some(start_offset) = input[cursor..].find("-----BEGIN ") {
        let start = cursor + start_offset;
        output.push_str(&input[cursor..start]);
        let label_end = input[start + 11..]
            .find("-----")
            .map(|offset| start + 11 + offset)
            .unwrap_or(start + 11);
        let label = &input[start + 11..label_end];
        let end_marker = format!("-----END {label}-----");
        output.push_str("[REDACTED_PRIVATE_KEY]");
        if let Some(end_offset) = input[label_end..].find(&end_marker) {
            cursor = label_end + end_offset + end_marker.len();
        } else {
            return output;
        }
    }
    output.push_str(&input[cursor..]);
    output
}

fn redact_data_urls(input: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let mut cursor = 0;
    while let Some(start_offset) = input[cursor..].find("data:") {
        let start = cursor + start_offset;
        output.push_str(&input[cursor..start]);
        let payload_start = input[start..]
            .find(',')
            .map(|offset| start + offset + 1)
            .unwrap_or_else(|| {
                input[start..]
                    .find_whitespace()
                    .map(|offset| start + offset)
                    .unwrap_or(input.len())
            });
        output.push_str("[REDACTED_DATA_URL]");
        cursor = input[payload_start..]
            .find_whitespace()
            .map(|offset| payload_start + offset)
            .unwrap_or(input.len());
        if cursor < input.len() {
            output.push(' ');
        }
    }
    output.push_str(&input[cursor..]);
    output
}

trait FindWhitespace {
    fn find_whitespace(&self) -> Option<usize>;
}

impl FindWhitespace for str {
    fn find_whitespace(&self) -> Option<usize> {
        self.char_indices()
            .find_map(|(index, character)| character.is_whitespace().then_some(index))
    }
}

fn redact_keyed_values(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut output = String::with_capacity(input.len());
    let mut index = 0;
    while index < bytes.len() {
        if !is_key_start(bytes[index]) {
            let character = input[index..].chars().next().unwrap_or_default();
            output.push(character);
            index += character.len_utf8();
            continue;
        }
        let key_start = index;
        while index < bytes.len() && is_key_char(bytes[index]) {
            index += 1;
        }
        let key = &input[key_start..index];
        let mut separator = index;
        while separator < bytes.len() && matches!(bytes[separator], b' ' | b'\t') {
            separator += 1;
        }
        if separator < bytes.len() && matches!(bytes[separator], b'"' | b'\'') {
            separator += 1;
            while separator < bytes.len() && matches!(bytes[separator], b' ' | b'\t') {
                separator += 1;
            }
        }
        if separator < bytes.len()
            && matches!(bytes[separator], b':' | b'=')
            && sensitive_key(key)
        {
            output.push_str(&input[key_start..separator + 1]);
            let mut value_start = separator + 1;
            while value_start < bytes.len()
                && matches!(bytes[value_start], b' ' | b'\t')
            {
                value_start += 1;
            }
            output.push_str("[REDACTED]");
            index = skip_sensitive_value(input, value_start, key);
            continue;
        }
        output.push_str(&input[key_start..index]);
    }
    output
}

fn skip_sensitive_value(input: &str, start: usize, key: &str) -> usize {
    let bytes = input.as_bytes();
    if start >= bytes.len() {
        return start;
    }
    if matches!(bytes[start], b'"' | b'\'') {
        let quote = bytes[start];
        let mut index = start + 1;
        let mut escaped = false;
        while index < bytes.len() {
            let byte = bytes[index];
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == quote {
                return index + 1;
            }
            index += 1;
        }
        return index;
    }
    let mut index = start;
    if is_header_secret_key(key) {
        while index < bytes.len() && !matches!(bytes[index], b'\r' | b'\n') {
            index += 1;
        }
        return index;
    }
    while index < bytes.len()
        && !matches!(
            bytes[index],
            b' ' | b'\t' | b'\r' | b'\n' | b',' | b';' | b'&' | b'}' | b']'
        )
    {
        index += 1;
    }
    index
}

fn is_header_secret_key(key: &str) -> bool {
    let normalized = key
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect::<String>();
    matches!(
        normalized.as_str(),
        "authorization" | "xapikey" | "cookie" | "setcookie"
    )
}

fn redact_url_userinfo(input: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let mut cursor = 0;
    while let Some(relative) = input[cursor..].find("://") {
        let scheme_end = cursor + relative + 3;
        output.push_str(&input[cursor..scheme_end]);
        let authority_end = input[scheme_end..]
            .find(|character| matches!(character, '/' | '?' | '#' | ' ' | '\r' | '\n'))
            .map(|offset| scheme_end + offset)
            .unwrap_or(input.len());
        let authority = &input[scheme_end..authority_end];
        if let Some(at) = authority.rfind('@') {
            if authority[..at].contains(':') {
                output.push_str("[REDACTED]");
                output.push_str(&authority[at..]);
                cursor = authority_end;
                continue;
            }
        }
        output.push_str(authority);
        cursor = authority_end;
    }
    output.push_str(&input[cursor..]);
    output
}

fn redact_bearer_tokens(input: &str) -> String {
    redact_after_case_insensitive_marker(input, "bearer")
}

fn redact_known_token_prefixes(input: &str) -> String {
    let prefixes = [
        "sk-",
        "sk_",
        "AIza",
        "xai-",
        "ghp_",
        "github_pat_",
        "xoxb-",
        "xoxp-",
    ];
    let bytes = input.as_bytes();
    let mut output = String::with_capacity(input.len());
    let mut index = 0;
    while index < bytes.len() {
        let remainder = &input[index..];
        let prefix = prefixes
            .iter()
            .find(|prefix| remainder.starts_with(**prefix));
        if let Some(prefix) = prefix {
            output.push_str("[REDACTED_TOKEN]");
            index += prefix.len();
            while index < bytes.len()
                && !matches!(
                    bytes[index],
                    b' ' | b'\t' | b'\r' | b'\n' | b'"' | b'\'' | b',' | b';' | b'}' | b']'
                )
            {
                index += 1;
            }
        } else {
            let character = input[index..].chars().next().unwrap_or_default();
            output.push(character);
            index += character.len_utf8();
        }
    }
    output
}

fn redact_after_case_insensitive_marker(input: &str, marker: &str) -> String {
    let lower = input.to_ascii_lowercase();
    let mut output = String::with_capacity(input.len());
    let mut cursor = 0;
    let mut search = 0;
    while let Some(relative) = lower[search..].find(marker) {
        let marker_start = search + relative;
        let marker_end = marker_start + marker.len();
        let boundary_before =
            marker_start == 0 || !is_key_char(input.as_bytes()[marker_start - 1]);
        if !boundary_before {
            search = marker_end;
            continue;
        }
        let mut value_start = marker_end;
        let bytes = input.as_bytes();
        while value_start < bytes.len() && matches!(bytes[value_start], b' ' | b'\t') {
            value_start += 1;
        }
        if value_start == marker_end {
            search = marker_end;
            continue;
        }
        output.push_str(&input[cursor..marker_end]);
        output.push_str(" [REDACTED_TOKEN]");
        let mut end = value_start;
        while end < bytes.len()
            && !matches!(
                bytes[end],
                b' ' | b'\t' | b'\r' | b'\n' | b'"' | b'\'' | b',' | b';' | b'}' | b']'
            )
        {
            end += 1;
        }
        cursor = end;
        search = end;
    }
    output.push_str(&input[cursor..]);
    output
}

fn is_key_start(byte: u8) -> bool {
    byte.is_ascii_alphabetic() || byte == b'_'
}

fn is_key_char(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-')
}

fn truncate_chars(value: &str, limit: usize) -> String {
    let mut chars = value.chars();
    let truncated = chars.by_ref().take(limit).collect::<String>();
    if chars.next().is_some() {
        format!("{truncated}…[truncated]")
    } else {
        truncated
    }
}

struct RotatingFileWriter {
    directory: PathBuf,
    file_name: String,
    file: File,
    size: u64,
    max_bytes: u64,
    max_rotated_files: usize,
    unsynced_records: u32,
}

impl RotatingFileWriter {
    fn new(
        directory: &Path,
        file_name: &str,
        max_bytes: u64,
        max_rotated_files: usize,
    ) -> io::Result<Self> {
        fs::create_dir_all(directory)?;
        let path = directory.join(file_name);
        let mut writer = Self {
            directory: directory.to_path_buf(),
            file_name: file_name.to_string(),
            file: open_append(&path)?,
            size: fs::metadata(&path).map(|metadata| metadata.len()).unwrap_or(0),
            max_bytes: max_bytes.max(1),
            max_rotated_files: max_rotated_files.max(1),
            unsynced_records: 0,
        };
        if writer.size >= writer.max_bytes {
            writer.rotate()?;
        } else {
            writer.prune_extra_files()?;
        }
        Ok(writer)
    }

    fn write_line(&mut self, bytes: &[u8]) -> io::Result<()> {
        let record_size = bytes.len() as u64 + 1;
        if self.size > 0 && self.size.saturating_add(record_size) > self.max_bytes {
            self.rotate()?;
        }
        self.file.write_all(bytes)?;
        self.file.write_all(b"\n")?;
        self.size = self.size.saturating_add(record_size);
        self.unsynced_records = self.unsynced_records.saturating_add(1);
        Ok(())
    }

    fn flush(&mut self, sync: bool) -> io::Result<()> {
        self.file.flush()?;
        if sync || self.unsynced_records >= 32 {
            self.file.sync_data()?;
            self.unsynced_records = 0;
        }
        Ok(())
    }

    fn rotate(&mut self) -> io::Result<()> {
        self.file.flush()?;
        self.file.sync_data()?;
        let active = self.directory.join(&self.file_name);
        let oldest = self.rotated_path(self.max_rotated_files + 1);
        if oldest.exists() {
            fs::remove_file(oldest)?;
        }
        for index in (1..=self.max_rotated_files).rev() {
            let source = self.rotated_path(index);
            if source.exists() {
                fs::rename(source, self.rotated_path(index + 1))?;
            }
        }
        if active.exists() {
            fs::rename(&active, self.rotated_path(1))?;
        }
        self.file = open_append(&active)?;
        self.size = 0;
        self.unsynced_records = 0;
        self.prune_extra_files()
    }

    fn rotated_path(&self, index: usize) -> PathBuf {
        let path = Path::new(&self.file_name);
        let stem = path
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("knowmotion");
        let extension = path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("log");
        self.directory
            .join(format!("{stem}.{index}.{extension}"))
    }

    fn prune_extra_files(&self) -> io::Result<()> {
        let Some(extension) = Path::new(&self.file_name)
            .extension()
            .and_then(|value| value.to_str())
        else {
            return Ok(());
        };
        for entry in fs::read_dir(&self.directory)? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().to_string();
            if name == self.file_name {
                continue;
            }
            if entry.path().extension().and_then(|value| value.to_str()) != Some(extension) {
                continue;
            }
            let index = name
                .split('.')
                .nth(1)
                .and_then(|value| value.parse::<usize>().ok());
            let expired = entry
                .metadata()
                .and_then(|metadata| metadata.modified())
                .ok()
                .and_then(|modified| SystemTime::now().duration_since(modified).ok())
                .is_some_and(|age| age > Duration::from_secs(MAX_LOG_AGE_DAYS * 86_400));
            if index.is_some_and(|index| index > self.max_rotated_files) || expired {
                fs::remove_file(entry.path())?;
            }
        }
        Ok(())
    }
}

fn open_append(path: &Path) -> io::Result<File> {
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unified_redaction_covers_headers_json_queries_and_tokens() {
        let input = concat!(
            "Authorization: Bearer sk-live-secret-value\n",
            "x-api-key: abc123\n",
            "Cookie: session=cookie-secret; theme=dark\n",
            "https://user:url-password@example.test/path\n",
            "https://api.example.test/v1?api_key=query-secret&safe=1\n",
            "{\"password\":\"json-secret\",\"token\":\"token-secret\",\"max_tokens\":88}\n",
            "Bearer opaque-bearer-value ghp_github-secret",
        );
        let redacted = redact_text(input);
        for secret in [
            "sk-live-secret-value",
            "abc123",
            "cookie-secret",
            "url-password",
            "query-secret",
            "json-secret",
            "token-secret",
            "opaque-bearer-value",
            "ghp_github-secret",
        ] {
            assert!(!redacted.contains(secret), "leaked {secret}: {redacted}");
        }
        assert!(redacted.contains("\"max_tokens\":88"));
        assert!(redacted.contains("safe=1"));
    }

    #[test]
    fn structured_redaction_is_recursive_and_preserves_usage_tokens() {
        let value = json!({
            "apiKey": "secret",
            "prompt": "private prompt",
            "nested": {
                "access_token": "secret-two",
                "max_tokens": 100
            },
            "note": "Bearer secret-three"
        });
        let redacted = redact_json(value).to_string();
        assert!(!redacted.contains("secret-two"));
        assert!(!redacted.contains("secret-three"));
        assert!(!redacted.contains("private prompt"));
        assert!(redacted.contains("\"max_tokens\":100"));
    }

    #[test]
    fn private_keys_and_data_urls_are_redacted() {
        let input = concat!(
            "-----BEGIN PRIVATE KEY-----\nsecret-key-body\n",
            "-----END PRIVATE KEY----- data:image/png;base64,QUJDREVGRw=="
        );
        let redacted = redact_text(input);
        assert!(!redacted.contains("secret-key-body"));
        assert!(!redacted.contains("QUJDREVGRw"));
    }

    #[test]
    fn log_files_rotate_by_size_and_prune_old_generations() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let mut writer =
            RotatingFileWriter::new(directory.path(), "test.log", 160, 3).expect("writer");
        for index in 0..20 {
            writer
                .write_line(format!("record-{index:02}-xxxxxxxxxxxxxxxx").as_bytes())
                .expect("write record");
        }
        writer.flush(true).expect("sync logs");

        assert!(directory.path().join("test.log").is_file());
        assert!(directory.path().join("test.1.log").is_file());
        assert!(!directory.path().join("test.4.log").exists());
        let total = fs::read_dir(directory.path())
            .expect("read logs")
            .filter_map(Result::ok)
            .map(|entry| entry.metadata().map(|metadata| metadata.len()).unwrap_or(0))
            .sum::<u64>();
        assert!(total < 800, "rotation exceeded retention size: {total}");
    }

    #[test]
    fn global_pipeline_writes_structured_redacted_jsonl() {
        let directory = tempfile::tempdir().expect("temporary directory");
        init(directory.path()).expect("initialize logger");
        log_event(
            LogLevel::Error,
            "test",
            "Request failed Authorization: Bearer sk-test-secret",
            Some(json!({
                "apiKey": "structured-secret",
                "status": 429
            })),
        );
        flush().expect("flush logger");
        let content =
            fs::read_to_string(directory.path().join(LOG_FILE_NAME)).expect("read log");
        assert!(content.contains("\"level\":\"error\""));
        assert!(content.contains("\"status\":429"));
        assert!(!content.contains("sk-test-secret"));
        assert!(!content.contains("structured-secret"));
        shutdown();
    }
}
