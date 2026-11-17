use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::OnceLock,
    time::Duration,
};
use tokio::sync::Mutex;

const MAX_ARCHIVE_BYTES: usize = 1024 * 1024 * 1024;
const MAX_RUNTIME_FILES: usize = 4096;
const RUNTIME_HASH_BUFFER_BYTES: usize = 1024 * 1024;
static RUNTIME_ROOT: OnceLock<PathBuf> = OnceLock::new();
static INSTALL_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum RuntimeAcceleration {
    /// Pinned CUDA 12.4 archives. Highest compute capability they were built for is 9.x.
    Cuda,
    /// Pinned CUDA 13.x archives. The only CUDA build with kernels for Blackwell (10.x/12.x).
    Cuda13,
    Vulkan,
}

impl RuntimeAcceleration {
    fn label(self) -> &'static str {
        match self {
            Self::Cuda => "CUDA 12.4",
            Self::Cuda13 => "CUDA 13",
            Self::Vulkan => "Vulkan",
        }
    }

    fn manifest_label(self) -> &'static str {
        match self {
            Self::Cuda => "cuda12.4",
            Self::Cuda13 => "cuda13",
            Self::Vulkan => "vulkan",
        }
    }

    /// Backend name understood by the managed servers. Both CUDA variants keep
    /// reporting `cuda`, because audio.cpp/stable-diffusion.cpp only know
    /// `cuda` and `vulkan`; the toolkit minor version is an installation
    /// detail, not a runtime switch.
    fn backend_name(self) -> &'static str {
        match self {
            Self::Cuda | Self::Cuda13 => "cuda",
            Self::Vulkan => "vulkan",
        }
    }
}

#[derive(Clone, Copy)]
struct RuntimeArchive {
    name: &'static str,
    download_url: &'static str,
    sha256: &'static str,
}

#[derive(Clone, Copy)]
struct RuntimeSpec {
    id: &'static str,
    version: &'static str,
    executable_name: &'static str,
    cuda: &'static [RuntimeArchive],
    /// CUDA 13.x archives. Empty when the project does not publish one, in
    /// which case Blackwell devices keep falling back to Vulkan.
    cuda13: &'static [RuntimeArchive],
    vulkan: &'static [RuntimeArchive],
}

const LLAMA_CUDA: [RuntimeArchive; 2] = [
    RuntimeArchive {
        name: "llama-b12359-bin-win-cuda-12.4-x64.zip",
        download_url:
            "https://github.com/ggml-org/llama.cpp/releases/download/b12359/llama-b12359-bin-win-cuda-12.4-x64.zip",
        sha256: "e9c0abf442e8339c06728366c1ad2c711332f9939c0c00603fb75d85fd44c914",
    },
    RuntimeArchive {
        name: "cudart-llama-bin-win-cuda-12.4-x64.zip",
        download_url:
            "https://github.com/ggml-org/llama.cpp/releases/download/b12359/cudart-llama-bin-win-cuda-12.4-x64.zip",
        sha256: "8c79a9b226de4b3cacfd1f83d24f962d0773be79f1e7b75c6af4ded7e32ae1d6",
    },
];

const LLAMA_CUDA13: [RuntimeArchive; 2] = [
    RuntimeArchive {
        name: "llama-b12359-bin-win-cuda-13.5-x64.zip",
        download_url:
            "https://github.com/ggml-org/llama.cpp/releases/download/b12359/llama-b12359-bin-win-cuda-13.5-x64.zip",
        sha256: "1de9ca1ff408d6e348ea0007c6880ad2393311a02e7799bcde26dc16daef03dd",
    },
    RuntimeArchive {
        name: "cudart-llama-bin-win-cuda-13.5-x64.zip",
        download_url:
            "https://github.com/ggml-org/llama.cpp/releases/download/b12359/cudart-llama-bin-win-cuda-13.5-x64.zip",
        sha256: "c2bf4cc202bfbaaa7a0b75f5082457c3811326947bb216059b72839d844e9cba",
    },
];

const LLAMA_VULKAN: [RuntimeArchive; 1] = [RuntimeArchive {
    name: "llama-b12359-bin-win-vulkan-x64.zip",
    download_url:
        "https://github.com/ggml-org/llama.cpp/releases/download/b12359/llama-b12359-bin-win-vulkan-x64.zip",
    sha256: "e8d18c6e4210cca87e7307c2ea78363ac8d158e4e1397358ec96ab70b53a0d5e",
}];

const AUDIO_CUDA: [RuntimeArchive; 2] = [
    RuntimeArchive {
        name: "audio-v0.9.5-bin-windows-x64-cuda12.4.zip",
        download_url:
            "https://github.com/0xShug0/audio.cpp/releases/download/v0.9.5/audio-v0.9.5-bin-windows-x64-cuda12.4.zip",
        sha256: "81f38a0a62935bdf4b2605541a21d50223b2e12b661887031705dd8a369f844b",
    },
    RuntimeArchive {
        name: "audio-v0.9.5-cudart-windows-x64-cuda12.4.zip",
        download_url:
            "https://github.com/0xShug0/audio.cpp/releases/download/v0.9.5/audio-v0.9.5-cudart-windows-x64-cuda12.4.zip",
        sha256: "fa55dfaff1d4b5c6e8fac460d64f380b9df76cd46435f187c39b05700f623a7e",
    },
];

const AUDIO_CUDA13: [RuntimeArchive; 2] = [
    RuntimeArchive {
        name: "audio-v0.9.5-bin-windows-x64-cuda13.3.zip",
        download_url:
            "https://github.com/0xShug0/audio.cpp/releases/download/v0.9.5/audio-v0.9.5-bin-windows-x64-cuda13.3.zip",
        sha256: "9d413d8565ad26e1ae33743e9c884e733f1684169be6f8934e1af9ee2e57a872",
    },
    RuntimeArchive {
        name: "audio-v0.9.5-cudart-windows-x64-cuda13.3.zip",
        download_url:
            "https://github.com/0xShug0/audio.cpp/releases/download/v0.9.5/audio-v0.9.5-cudart-windows-x64-cuda13.3.zip",
        sha256: "8614040110cc5852b1dd2192e80344295500f4fa7f3199a51c737c2c7549c3dc",
    },
];

const AUDIO_VULKAN: [RuntimeArchive; 1] = [RuntimeArchive {
    name: "audio-v0.9.5-bin-windows-x64-vulkan-portable.zip",
    download_url:
        "https://github.com/0xShug0/audio.cpp/releases/download/v0.9.5/audio-v0.9.5-bin-windows-x64-vulkan-portable.zip",
    sha256: "6c304c9a1e0cfc18b2d3b208b03d40365fec71d094ee4da4f695b2d9e7de29e8",
}];

const STABLE_DIFFUSION_CUDA: [RuntimeArchive; 2] = [
    RuntimeArchive {
        name: "sd-master-532d2c1-bin-win-cuda12-x64.zip",
        download_url:
            "https://github.com/leejet/stable-diffusion.cpp/releases/download/master-1106-532d2c1/sd-master-532d2c1-bin-win-cuda12-x64.zip",
        sha256: "b087219145a382cc1b1e826318289e1f672b9bb6965977734ef0deb85fe2d03a",
    },
    RuntimeArchive {
        name: "cudart-sd-bin-win-cu12-x64.zip",
        download_url:
            "https://github.com/leejet/stable-diffusion.cpp/releases/download/master-1106-532d2c1/cudart-sd-bin-win-cu12-x64.zip",
        sha256: "fe20366827d357c00797eebb58244dddab7fd9a348d70090c3871004c320f38d",
    },
];

const STABLE_DIFFUSION_VULKAN: [RuntimeArchive; 1] = [RuntimeArchive {
    name: "sd-master-532d2c1-bin-win-vulkan-x64.zip",
    download_url:
        "https://github.com/leejet/stable-diffusion.cpp/releases/download/master-1106-532d2c1/sd-master-532d2c1-bin-win-vulkan-x64.zip",
    sha256: "3e66222c87ca27074e1fd8ce79706eef17a8aaf39949906aa1bee7e060f22ecc",
}];

/// stable-diffusion.cpp `master-1106-532d2c1` publishes no CUDA 13 archive, so
/// Blackwell keeps using the Vulkan build for image generation.
const STABLE_DIFFUSION_CUDA13: [RuntimeArchive; 0] = [];

const RUNTIMES: [RuntimeSpec; 3] = [
    RuntimeSpec {
        id: "llama.cpp",
        version: "b12359",
        executable_name: "llama-server.exe",
        cuda: &LLAMA_CUDA,
        cuda13: &LLAMA_CUDA13,
        vulkan: &LLAMA_VULKAN,
    },
    RuntimeSpec {
        id: "audio.cpp",
        version: "v0.9.5",
        executable_name: "audiocpp_server.exe",
        cuda: &AUDIO_CUDA,
        cuda13: &AUDIO_CUDA13,
        vulkan: &AUDIO_VULKAN,
    },
    RuntimeSpec {
        id: "stable-diffusion.cpp",
        version: "master-1106-532d2c1",
        executable_name: "sd-server.exe",
        cuda: &STABLE_DIFFUSION_CUDA,
        cuda13: &STABLE_DIFFUSION_CUDA13,
        vulkan: &STABLE_DIFFUSION_VULKAN,
    },
];

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeManifest {
    runtime: String,
    version: String,
    acceleration: RuntimeAcceleration,
    archives: Vec<String>,
    executable: String,
    /// SHA-256 for every installed runtime file except the manifest itself.
    /// Missing/empty lists are treated as legacy installs and repaired.
    #[serde(default)]
    files: Vec<RuntimeFileHash>,
    installed_at: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct RuntimeFileHash {
    path: String,
    bytes: u64,
    sha256: String,
}

#[derive(Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeInstallResult {
    pub runtime: String,
    pub version: String,
    pub acceleration: String,
    pub install_path: String,
    pub executable_path: String,
    pub already_installed: bool,
    pub repair_performed: bool,
}

pub(crate) fn configure(install_root: PathBuf) {
    let _ = RUNTIME_ROOT.set(install_root);
}

fn install_root() -> Result<&'static Path, String> {
    RUNTIME_ROOT
        .get()
        .map(PathBuf::as_path)
        .ok_or_else(|| "Local runtime directory is not configured".to_string())
}

fn runtime_spec(runtime: &str) -> Result<RuntimeSpec, String> {
    RUNTIMES
        .iter()
        .copied()
        .find(|spec| spec.id == runtime)
        .ok_or_else(|| format!("Unsupported local runtime: {runtime}"))
}

fn archives_for(spec: RuntimeSpec, acceleration: RuntimeAcceleration) -> &'static [RuntimeArchive] {
    match acceleration {
        RuntimeAcceleration::Cuda => spec.cuda,
        RuntimeAcceleration::Cuda13 => spec.cuda13,
        RuntimeAcceleration::Vulkan => spec.vulkan,
    }
}

fn archive_hashes(archives: &[RuntimeArchive]) -> Vec<String> {
    archives.iter().map(archive_sha256).collect()
}

fn automation_runtime_override() -> Option<(String, String)> {
    if std::env::var("TAURI_WEBVIEW_AUTOMATION").as_deref() != Ok("true") {
        return None;
    }
    let base = std::env::var("KNOWMOTION_E2E_RUNTIME_BASE_URL").ok()?;
    let sha256 = std::env::var("KNOWMOTION_E2E_RUNTIME_SHA256").ok()?;
    Some((base.trim_end_matches('/').to_string(), sha256))
}

fn archive_download_url(archive: &RuntimeArchive) -> String {
    automation_runtime_override()
        .map(|(base, _)| format!("{base}/{}", archive.name))
        .unwrap_or_else(|| archive.download_url.to_string())
}

fn archive_sha256(archive: &RuntimeArchive) -> String {
    automation_runtime_override()
        .map(|(_, sha256)| sha256)
        .unwrap_or_else(|| archive.sha256.to_string())
}

fn manifest_executable(target: &Path, manifest: &RuntimeManifest) -> Result<PathBuf, String> {
    let relative = crate::storage::safe_relative_path(&manifest.executable)
        .ok_or_else(|| "Runtime manifest contains an unsafe executable path".to_string())?;
    let executable = target.join(relative);
    let canonical_target = target
        .canonicalize()
        .map_err(|error| format!("Runtime directory is unavailable: {error}"))?;
    let canonical_executable = executable
        .canonicalize()
        .map_err(|error| format!("Runtime executable is unavailable: {error}"))?;
    if !canonical_executable.starts_with(&canonical_target) || !canonical_executable.is_file() {
        return Err("Runtime executable escapes its installation directory".to_string());
    }
    Ok(canonical_executable)
}

fn hash_file(path: &Path) -> Result<String, String> {
    let mut file =
        File::open(path).map_err(|error| format!("Unable to open runtime file: {error}"))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; RUNTIME_HASH_BUFFER_BYTES];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("Unable to read runtime file: {error}"))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex::encode(hasher.finalize()))
}

fn collect_runtime_files(
    root: &Path,
    current: &Path,
    files: &mut Vec<RuntimeFileHash>,
) -> Result<(), String> {
    for entry in fs::read_dir(current).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        let file_type = entry.file_type().map_err(|error| error.to_string())?;
        if file_type.is_symlink() {
            return Err("Runtime archive contains a symbolic link".to_string());
        }
        if file_type.is_dir() {
            collect_runtime_files(root, &path, files)?;
            continue;
        }
        if !file_type.is_file()
            || path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.eq_ignore_ascii_case("manifest.json"))
        {
            continue;
        }
        if files.len() >= MAX_RUNTIME_FILES {
            return Err(format!(
                "Runtime contains more than {MAX_RUNTIME_FILES} files"
            ));
        }
        let relative = path
            .strip_prefix(root)
            .map_err(|error| error.to_string())?
            .to_string_lossy()
            .replace('\\', "/");
        let metadata = entry.metadata().map_err(|error| error.to_string())?;
        files.push(RuntimeFileHash {
            path: relative,
            bytes: metadata.len(),
            sha256: hash_file(&path)?,
        });
    }
    Ok(())
}

fn runtime_files(root: &Path) -> Result<Vec<RuntimeFileHash>, String> {
    let mut files = Vec::new();
    collect_runtime_files(root, root, &mut files)?;
    files.sort_by(|left, right| left.path.cmp(&right.path));
    if files.is_empty() {
        return Err("Runtime package contains no files".to_string());
    }
    Ok(files)
}

fn verify_runtime_files(target: &Path, files: &[RuntimeFileHash]) -> Result<(), String> {
    if files.is_empty() {
        return Err("Runtime manifest has no per-file integrity data".to_string());
    }
    let canonical_target = target
        .canonicalize()
        .map_err(|error| format!("Runtime directory is unavailable: {error}"))?;
    for expected in files {
        let relative = crate::storage::safe_relative_path(&expected.path)
            .ok_or_else(|| "Runtime manifest contains an unsafe file path".to_string())?;
        let path = target.join(relative);
        let canonical = path
            .canonicalize()
            .map_err(|_| format!("Runtime file is missing: {}", expected.path))?;
        if !canonical.starts_with(&canonical_target) || !canonical.is_file() {
            return Err(format!("Runtime file is invalid: {}", expected.path));
        }
        let length = fs::metadata(&canonical)
            .map_err(|error| error.to_string())?
            .len();
        if length != expected.bytes {
            return Err(format!(
                "Runtime file size mismatch for {}: expected {}, got {}",
                expected.path, expected.bytes, length
            ));
        }
        let actual = hash_file(&canonical)?;
        if actual != expected.sha256 {
            return Err(format!(
                "Runtime file checksum mismatch for {}: expected {}, got {}",
                expected.path, expected.sha256, actual
            ));
        }
    }
    Ok(())
}

fn load_installed_manifest(
    spec: RuntimeSpec,
    acceleration: RuntimeAcceleration,
) -> Result<Option<(RuntimeManifest, PathBuf)>, String> {
    let target = install_root()?.join(spec.id);
    let manifest_path = target.join("manifest.json");
    let text = match fs::read_to_string(manifest_path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("Runtime manifest could not be read: {error}")),
    };
    let manifest: RuntimeManifest = serde_json::from_str(&text)
        .map_err(|error| format!("Runtime manifest is invalid: {error}"))?;
    if manifest.runtime != spec.id
        || manifest.version != spec.version
        || manifest.acceleration != acceleration
        || manifest.archives != archive_hashes(archives_for(spec, acceleration))
    {
        return Ok(None);
    }
    let executable = manifest_executable(&target, &manifest)?;
    verify_runtime_files(&target, &manifest.files)?;
    Ok(Some((manifest, executable)))
}

fn load_any_installed_manifest(
    spec: RuntimeSpec,
) -> Result<Option<(RuntimeManifest, PathBuf)>, String> {
    let target = install_root()?.join(spec.id);
    let text = match fs::read_to_string(target.join("manifest.json")) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("Runtime manifest could not be read: {error}")),
    };
    let manifest: RuntimeManifest = serde_json::from_str(&text)
        .map_err(|error| format!("Runtime manifest is invalid: {error}"))?;
    if manifest.runtime != spec.id || manifest.version != spec.version {
        return Ok(None);
    }
    let executable = manifest_executable(&target, &manifest)?;
    verify_runtime_files(&target, &manifest.files)?;
    Ok(Some((manifest, executable)))
}

pub(crate) fn installed_executable(runtime: &str) -> Option<PathBuf> {
    let spec = runtime_spec(runtime).ok()?;
    load_any_installed_manifest(spec)
        .ok()
        .flatten()
        .map(|(_, executable)| executable)
}

pub(crate) fn installed_acceleration(runtime: &str) -> Option<String> {
    let spec = runtime_spec(runtime).ok()?;
    load_any_installed_manifest(spec)
        .ok()
        .flatten()
        .map(|(manifest, _)| manifest.acceleration.backend_name().to_string())
}

#[cfg(test)]
fn sha256(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn find_named_file(root: &Path, name: &str, depth: usize) -> Option<PathBuf> {
    if depth == 0 {
        return None;
    }
    let entries = fs::read_dir(root).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file()
            && path
                .file_name()
                .and_then(|value| value.to_str())
                .is_some_and(|value| value.eq_ignore_ascii_case(name))
        {
            return Some(path);
        }
        if path.is_dir() {
            if let Some(found) = find_named_file(&path, name, depth - 1) {
                return Some(found);
            }
        }
    }
    None
}

#[cfg(windows)]
fn hidden_command(program: &str) -> Command {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let mut command = Command::new(program);
    command.creation_flags(CREATE_NO_WINDOW);
    command
}

#[cfg(not(windows))]
fn hidden_command(program: &str) -> Command {
    Command::new(program)
}

/// 判断固定版本 CUDA 12.4 运行时能否在这块显卡上真正执行。
///
/// 只判断驱动下限是不够的：CUDA 12.4 工具链最高只能生成 compute capability
/// 9.x 的 kernel，Blackwell（10.x/12.x，如 RTX 50 系）在 CUDA 12.4 归档里没有
/// 可执行的 kernel image，启动后会退回 CPU 或直接报错。
fn cuda_12_4_supports(driver_major: u32, compute_capability: f32) -> bool {
    driver_major >= 551 && (5.0..10.0).contains(&compute_capability)
}

/// 判断 CUDA 13.x 归档能否在这块显卡上执行。
///
/// 两个门槛：
/// - 驱动：本项目固定的是 llama.cpp 的 CUDA 13.5 与 audio.cpp 的 CUDA 13.3 归档，
///   对应驱动分支分别是 R620 / R610（CUDA 13.x 的 minor version compatibility
///   最低是 R580，但 13.5 的新特性要求 R620）。取两者更严的 R620，避免在
///   580–619 的机器上装好却起不来。
/// - 计算能力：CUDA 13 已取消 Maxwell/Pascal/Volta 的离线编译，最低 Turing（7.5）；
///   上限不设，Blackwell（10.x/12.x）正是这一档要覆盖的目标。
fn cuda_13_supports(driver_major: u32, compute_capability: f32) -> bool {
    driver_major >= CUDA13_MIN_DRIVER && compute_capability >= 7.5
}

/// 首个能执行 CUDA 13 kernel 的最低驱动分支（R620 = CUDA 13.5）。
const CUDA13_MIN_DRIVER: u32 = 620;

/// 读取所有 NVIDIA 显卡的（驱动主版本，计算能力）。`nvidia-smi` 不可用时返回空。
fn detected_gpus() -> Vec<(u32, f32)> {
    let candidates = [
        "nvidia-smi.exe",
        "C:\\Windows\\System32\\nvidia-smi.exe",
        "C:\\Program Files\\NVIDIA Corporation\\NVSMI\\nvidia-smi.exe",
    ];
    for executable in candidates {
        let detailed = hidden_command(executable)
            .args([
                "--query-gpu=driver_version,compute_cap",
                "--format=csv,noheader",
            ])
            .stdin(Stdio::null())
            .output();
        let text = if detailed
            .as_ref()
            .is_ok_and(|output| output.status.success())
        {
            String::from_utf8_lossy(&detailed.expect("checked output").stdout).to_string()
        } else {
            let fallback = hidden_command(executable)
                .args(["--query-gpu=driver_version", "--format=csv,noheader"])
                .stdin(Stdio::null())
                .output();
            let Ok(fallback) = fallback else {
                continue;
            };
            if !fallback.status.success() {
                continue;
            }
            String::from_utf8_lossy(&fallback.stdout).to_string()
        };
        let gpus = text
            .lines()
            .filter(|line| !line.trim().is_empty())
            .filter_map(|line| {
                let fields = line.split(',').map(str::trim).collect::<Vec<_>>();
                let driver_major = fields
                    .first()
                    .and_then(|value| value.split('.').next())
                    .and_then(|value| value.parse::<u32>().ok())?;
                let compute_capability = fields
                    .get(1)
                    .and_then(|value| value.parse::<f32>().ok())
                    // 旧版 nvidia-smi 不返回 compute_cap 时按 CUDA 12.4 的
                    // 最低受支持能力处理，保持历史行为不变。
                    .unwrap_or(5.0);
                Some((driver_major, compute_capability))
            })
            .collect::<Vec<_>>();
        if !gpus.is_empty() {
            return gpus;
        }
    }
    Vec::new()
}

/// 在给定显卡列表里挑加速后端。纯函数，便于测试各代显卡的组合。
///
/// 优先级：CUDA 12.4（存量机器不重新下载）→ CUDA 13（Blackwell 唯一可用 CUDA）
/// → Vulkan（兜底，始终可用）。
fn select_acceleration(has_cuda13: bool, gpus: &[(u32, f32)]) -> RuntimeAcceleration {
    if gpus
        .iter()
        .any(|(driver, compute)| cuda_12_4_supports(*driver, *compute))
    {
        return RuntimeAcceleration::Cuda;
    }
    if has_cuda13
        && gpus
            .iter()
            .any(|(driver, compute)| cuda_13_supports(*driver, *compute))
    {
        return RuntimeAcceleration::Cuda13;
    }
    RuntimeAcceleration::Vulkan
}

fn choose_acceleration(spec: RuntimeSpec) -> RuntimeAcceleration {
    select_acceleration(!spec.cuda13.is_empty(), &detected_gpus())
}

fn extract_zip(archive: &Path, destination: &Path) -> Result<(), String> {
    #[cfg(windows)]
    {
        let status = hidden_command("tar.exe")
            .args(["-xf"])
            .arg(archive)
            .arg("-C")
            .arg(destination)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .status()
            .map_err(|error| format!("Unable to start archive extractor: {error}"))?;
        if !status.success() {
            return Err(format!("Runtime archive extraction failed ({status})"));
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = (archive, destination);
        Err("Local runtime installation is currently supported on Windows only".to_string())
    }
}

fn remove_if_present(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    if path.is_dir() {
        fs::remove_dir_all(path).map_err(|error| error.to_string())
    } else {
        fs::remove_file(path).map_err(|error| error.to_string())
    }
}

fn installed_result(
    spec: RuntimeSpec,
    manifest: RuntimeManifest,
    executable: PathBuf,
    already_installed: bool,
    repair_performed: bool,
) -> RuntimeInstallResult {
    let target = install_root()
        .map(|root| root.join(spec.id))
        .unwrap_or_default();
    RuntimeInstallResult {
        runtime: spec.id.to_string(),
        version: manifest.version,
        acceleration: manifest.acceleration.label().to_string(),
        install_path: target.to_string_lossy().to_string(),
        executable_path: executable.to_string_lossy().to_string(),
        already_installed,
        repair_performed,
    }
}

#[tauri::command]
pub async fn ensure_local_runtime(runtime: String) -> Result<RuntimeInstallResult, String> {
    let spec = runtime_spec(&runtime)?;
    let acceleration = choose_acceleration(spec);
    let mut repair_performed = false;
    match load_installed_manifest(spec, acceleration) {
        Ok(Some((manifest, executable))) => {
            return Ok(installed_result(spec, manifest, executable, true, false));
        }
        Ok(None) => {}
        Err(error) => {
            repair_performed = true;
            crate::logging::log_event(
                crate::logging::LogLevel::Warn,
                "runtime",
                "Local runtime integrity check failed; automatic repair scheduled",
                Some(json!({ "runtime": spec.id, "error": error })),
            );
        }
    }

    let lock = INSTALL_LOCK.get_or_init(|| Mutex::new(()));
    let _guard = lock.lock().await;
    match load_installed_manifest(spec, acceleration) {
        Ok(Some((manifest, executable))) => {
            return Ok(installed_result(
                spec,
                manifest,
                executable,
                true,
                repair_performed,
            ));
        }
        Ok(None) => {}
        Err(error) => {
            repair_performed = true;
            crate::logging::log_event(
                crate::logging::LogLevel::Warn,
                "runtime",
                "Local runtime is damaged; reinstalling from the pinned archive",
                Some(json!({ "runtime": spec.id, "error": error })),
            );
        }
    }

    let root = install_root()?;
    fs::create_dir_all(root).map_err(|error| error.to_string())?;
    let downloads = root.join(".downloads");
    fs::create_dir_all(&downloads).map_err(|error| error.to_string())?;
    let target = root.join(spec.id);
    let staging = root.join(format!(".{}-installing", spec.id));
    remove_if_present(&staging)?;
    fs::create_dir_all(&staging).map_err(|error| error.to_string())?;

    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(30))
        .timeout(Duration::from_secs(45 * 60))
        .user_agent("KnowMotion-AI-Studio/0.1")
        .build()
        .map_err(|error| format!("Unable to create runtime download client: {error}"))?;
    let archives = archives_for(spec, acceleration);
    for archive in archives {
        let archive_path = downloads.join(archive.name);
        remove_if_present(&archive_path)?;
        let mut response = client
            .get(archive_download_url(archive))
            .send()
            .await
            .map_err(|error| format!("Runtime download failed: {error}"))?;
        if !response.status().is_success() {
            return Err(format!(
                "Runtime download returned {} for {}",
                response.status(),
                archive.name
            ));
        }
        if response
            .content_length()
            .is_some_and(|length| length > MAX_ARCHIVE_BYTES as u64)
        {
            return Err("Runtime archive exceeds the 1 GiB safety limit".to_string());
        }
        let mut file = File::create(&archive_path).map_err(|error| error.to_string())?;
        let mut hasher = Sha256::new();
        let mut total_bytes = 0usize;
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|error| format!("Unable to read runtime archive: {error}"))?
        {
            total_bytes = total_bytes.saturating_add(chunk.len());
            if total_bytes > MAX_ARCHIVE_BYTES {
                remove_if_present(&archive_path)?;
                return Err("Runtime archive exceeds the 1 GiB safety limit".to_string());
            }
            hasher.update(&chunk);
            file.write_all(&chunk).map_err(|error| error.to_string())?;
        }
        file.sync_all().map_err(|error| error.to_string())?;
        drop(file);
        let actual_sha256 = hex::encode(hasher.finalize());
        let expected_sha256 = archive_sha256(archive);
        if actual_sha256 != expected_sha256 {
            remove_if_present(&archive_path)?;
            return Err(format!(
                "Runtime checksum mismatch for {}: expected {}, got {}",
                archive.name, expected_sha256, actual_sha256
            ));
        }
        extract_zip(&archive_path, &staging)?;
        remove_if_present(&archive_path)?;
    }

    let executable = find_named_file(&staging, spec.executable_name, 8).ok_or_else(|| {
        format!(
            "Downloaded {} archive set does not contain {}",
            spec.id, spec.executable_name
        )
    })?;
    let executable_relative = executable
        .strip_prefix(&staging)
        .map_err(|error| error.to_string())?
        .to_path_buf();
    let files = runtime_files(&staging)?;
    let manifest = RuntimeManifest {
        runtime: spec.id.to_string(),
        version: spec.version.to_string(),
        acceleration,
        archives: archive_hashes(archives),
        executable: executable_relative.to_string_lossy().to_string(),
        files,
        installed_at: chrono::Utc::now().to_rfc3339(),
    };
    crate::write_atomic(
        &staging.join("manifest.json"),
        &serde_json::to_vec_pretty(&manifest).map_err(|error| error.to_string())?,
    )?;
    remove_if_present(&target)?;
    fs::rename(&staging, &target).map_err(|error| error.to_string())?;
    let installed_executable = target.join(executable_relative);
    crate::logging::log_event(
        crate::logging::LogLevel::Info,
        "runtime",
        "Local runtime installed",
        Some(json!({
            "runtime": spec.id,
            "version": spec.version,
            "acceleration": acceleration.manifest_label(),
            "path": target.to_string_lossy()
        })),
    );
    Ok(installed_result(
        spec,
        manifest,
        installed_executable,
        false,
        repair_performed,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn runtime_ids_are_unique_and_pinned() {
        let mut ids = RUNTIMES.iter().map(|spec| spec.id).collect::<Vec<_>>();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), RUNTIMES.len());
        assert!(RUNTIMES.iter().all(|spec| {
            !spec.cuda.is_empty()
                && !spec.vulkan.is_empty()
                && spec
                    .cuda
                    .iter()
                    .chain(spec.cuda13.iter())
                    .chain(spec.vulkan.iter())
                    .all(|archive| archive.sha256.len() == 64)
        }));
    }

    #[test]
    fn finds_nested_runtime_executable() {
        let root = tempdir().expect("temporary directory");
        let nested = root.path().join("bin/Release");
        fs::create_dir_all(&nested).expect("nested directory");
        fs::write(nested.join("sd-server.exe"), b"test").expect("executable");
        let found = find_named_file(root.path(), "sd-server.exe", 8).expect("runtime executable");
        assert_eq!(found, nested.join("sd-server.exe"));
    }

    #[test]
    fn runtime_hash_is_standard_sha256() {
        assert_eq!(
            sha256(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn returns_known_runtime_specs() {
        assert_eq!(runtime_spec("llama.cpp").expect("llama").version, "b12359");
        assert_eq!(
            runtime_spec("audio.cpp").expect("audio").executable_name,
            "audiocpp_server.exe"
        );
        assert!(runtime_spec("../audio.cpp").is_err());
    }

    #[test]
    fn cuda_assets_include_runtime_libraries() {
        let llama = runtime_spec("llama.cpp").expect("llama");
        assert_eq!(llama.cuda.len(), 2);
        assert!(llama
            .cuda
            .iter()
            .any(|archive| archive.name.starts_with("cudart-")));
    }

    #[test]
    fn cuda_asset_selection_excludes_blackwell() {
        // Ampere / Ada 可用 CUDA 12.4 归档。
        assert!(cuda_12_4_supports(551, 5.0));
        assert!(cuda_12_4_supports(566, 8.9));
        assert!(cuda_12_4_supports(621, 9.0));
        // 驱动过旧。
        assert!(!cuda_12_4_supports(550, 8.6));
        // Blackwell（RTX 50 系）在 CUDA 12.4 归档中没有 kernel，必须走 Vulkan 或 CUDA 13。
        assert!(!cuda_12_4_supports(621, 10.0));
        assert!(!cuda_12_4_supports(621, 12.0));
        // 低于受支持的最低计算能力。
        assert!(!cuda_12_4_supports(600, 3.5));
    }

    #[test]
    fn cuda13_assets_are_pinned_with_runtime_libraries() {
        let llama = runtime_spec("llama.cpp").expect("llama");
        assert_eq!(llama.cuda13.len(), 2);
        assert!(llama
            .cuda13
            .iter()
            .any(|archive| archive.name.contains("cuda-13.5-x64")
                && archive.name.starts_with("cudart-")));

        let audio = runtime_spec("audio.cpp").expect("audio");
        assert_eq!(audio.cuda13.len(), 2);
        assert!(audio
            .cuda13
            .iter()
            .any(|archive| archive.name.starts_with("audio-v0.9.5-cudart")
                && archive.name.contains("cuda13.3")));

        // stable-diffusion.cpp 没有发布 CUDA 13 归档，必须保持为空以继续回退 Vulkan。
        let diffusion = runtime_spec("stable-diffusion.cpp").expect("stable-diffusion");
        assert!(diffusion.cuda13.is_empty());
    }

    #[test]
    fn cuda13_selection_covers_blackwell() {
        // RTX 5070：驱动 621.24、计算能力 12.0，CUDA 12.4 不可用，CUDA 13 可用。
        assert!(!cuda_12_4_supports(621, 12.0));
        assert!(cuda_13_supports(621, 12.0));
        assert_eq!(
            select_acceleration(true, &[(621, 12.0)]),
            RuntimeAcceleration::Cuda13
        );
        // 运行时没有 CUDA 13 归档（stable-diffusion.cpp）时仍然走 Vulkan。
        assert_eq!(
            select_acceleration(false, &[(621, 12.0)]),
            RuntimeAcceleration::Vulkan
        );
        // Ada 上有既有 CUDA 12.4 归档就优先复用，不触发重新下载。
        assert_eq!(
            select_acceleration(true, &[(621, 8.9)]),
            RuntimeAcceleration::Cuda
        );
        // 驱动只有 R580 时 CUDA 13 归档起不来，退回 Vulkan。
        assert!(!cuda_13_supports(580, 12.0));
        assert_eq!(
            select_acceleration(true, &[(580, 12.0)]),
            RuntimeAcceleration::Vulkan
        );
        // CUDA 13 不再支持 Turing 之前的架构。
        assert!(!cuda_13_supports(621, 7.0));
        // 没有可见 NVIDIA 显卡。
        assert_eq!(select_acceleration(true, &[]), RuntimeAcceleration::Vulkan);
        // 多卡：只要有一张卡能跑固定 CUDA 12.4 归档，就沿用 12.4（那张卡可用）；
        // 两张都是 Blackwell 时才切到 CUDA 13。
        assert_eq!(
            select_acceleration(true, &[(560, 6.1), (621, 12.0)]),
            RuntimeAcceleration::Cuda
        );
        assert_eq!(
            select_acceleration(true, &[(580, 12.0), (621, 12.0)]),
            RuntimeAcceleration::Cuda13
        );
    }

    #[test]
    fn cuda13_manifests_keep_the_cuda_backend_name() {
        assert_eq!(RuntimeAcceleration::Cuda13.manifest_label(), "cuda13");
        assert_eq!(RuntimeAcceleration::Cuda13.label(), "CUDA 13");
        // 服务器进程只认 cuda / vulkan，不能把 cuda13 传下去。
        assert_eq!(RuntimeAcceleration::Cuda13.backend_name(), "cuda");
        assert_eq!(RuntimeAcceleration::Cuda.backend_name(), "cuda");
        assert_eq!(RuntimeAcceleration::Vulkan.backend_name(), "vulkan");
    }

    #[test]
    fn writes_expected_manifest_shape() {
        let file = RuntimeFileHash {
            path: "bin/audiocpp_server.exe".to_string(),
            bytes: 4,
            sha256: sha256(b"test"),
        };
        let manifest = RuntimeManifest {
            runtime: "audio.cpp".to_string(),
            version: "v0.9.5".to_string(),
            acceleration: RuntimeAcceleration::Cuda,
            archives: vec!["a".repeat(64)],
            executable: "bin/audiocpp_server.exe".to_string(),
            files: vec![file.clone()],
            installed_at: "2026-11-16T00:00:00Z".to_string(),
        };
        let value: serde_json::Value = serde_json::to_value(manifest).expect("manifest");
        assert_eq!(
            value
                .get("acceleration")
                .and_then(serde_json::Value::as_str),
            Some("cuda")
        );
        assert_eq!(value["files"][0]["path"], file.path);
        assert_eq!(value["files"][0]["sha256"], file.sha256);
    }

    #[test]
    fn runtime_file_hashes_detect_missing_and_modified_files() {
        let root = tempdir().expect("temporary directory");
        let bin = root.path().join("bin");
        fs::create_dir_all(&bin).expect("bin directory");
        fs::write(bin.join("server.exe"), b"original").expect("executable");
        fs::write(bin.join("runtime.dll"), b"library").expect("library");
        let files = runtime_files(root.path()).expect("file hashes");
        assert_eq!(files.len(), 2);
        verify_runtime_files(root.path(), &files).expect("intact runtime");

        fs::write(bin.join("runtime.dll"), b"corrupt").expect("corrupt library");
        let error = verify_runtime_files(root.path(), &files).expect_err("modified file");
        assert!(error.contains("checksum mismatch"));

        fs::write(bin.join("runtime.dll"), b"library").expect("restore library");
        fs::remove_file(bin.join("server.exe")).expect("remove executable");
        let error = verify_runtime_files(root.path(), &files).expect_err("missing file");
        assert!(error.contains("missing"));
    }

    #[test]
    fn legacy_manifest_without_hashes_requires_repair() {
        let root = tempdir().expect("temporary directory");
        let error = verify_runtime_files(root.path(), &[]).expect_err("legacy manifest");
        assert!(error.contains("no per-file integrity"));
    }

    #[test]
    fn executable_path_must_stay_inside_runtime_root() {
        let root = tempdir().expect("temporary directory");
        let outside = root.path().parent().expect("parent").join("outside.exe");
        fs::write(&outside, b"outside").expect("outside executable");
        fs::create_dir_all(root.path().join("bin")).expect("bin directory");
        let manifest = RuntimeManifest {
            runtime: "audio.cpp".to_string(),
            version: "v0.9.5".to_string(),
            acceleration: RuntimeAcceleration::Vulkan,
            archives: Vec::new(),
            executable: "../outside.exe".to_string(),
            files: Vec::new(),
            installed_at: "2026-11-16T00:00:00Z".to_string(),
        };
        assert!(manifest_executable(root.path(), &manifest).is_err());
        let _ = fs::remove_file(outside);
    }
}
