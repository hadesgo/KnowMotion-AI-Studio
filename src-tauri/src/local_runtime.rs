use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::OnceLock,
    time::Duration,
};
use tokio::sync::Mutex;

const MAX_ARCHIVE_BYTES: usize = 1024 * 1024 * 1024;
static RUNTIME_ROOT: OnceLock<PathBuf> = OnceLock::new();
static INSTALL_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum RuntimeAcceleration {
    Cuda,
    Vulkan,
}

impl RuntimeAcceleration {
    fn label(self) -> &'static str {
        match self {
            Self::Cuda => "CUDA 12.4",
            Self::Vulkan => "Vulkan",
        }
    }

    fn manifest_label(self) -> &'static str {
        match self {
            Self::Cuda => "cuda12.4",
            Self::Vulkan => "vulkan",
        }
    }

    fn backend_name(self) -> &'static str {
        match self {
            Self::Cuda => "cuda",
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

const RUNTIMES: [RuntimeSpec; 3] = [
    RuntimeSpec {
        id: "llama.cpp",
        version: "b12359",
        executable_name: "llama-server.exe",
        cuda: &LLAMA_CUDA,
        vulkan: &LLAMA_VULKAN,
    },
    RuntimeSpec {
        id: "audio.cpp",
        version: "v0.9.5",
        executable_name: "audiocpp_server.exe",
        cuda: &AUDIO_CUDA,
        vulkan: &AUDIO_VULKAN,
    },
    RuntimeSpec {
        id: "stable-diffusion.cpp",
        version: "master-1106-532d2c1",
        executable_name: "sd-server.exe",
        cuda: &STABLE_DIFFUSION_CUDA,
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
    installed_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeInstallResult {
    pub runtime: String,
    pub version: String,
    pub acceleration: String,
    pub install_path: String,
    pub executable_path: String,
    pub already_installed: bool,
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
        RuntimeAcceleration::Vulkan => spec.vulkan,
    }
}

fn archive_hashes(archives: &[RuntimeArchive]) -> Vec<String> {
    archives
        .iter()
        .map(|archive| archive.sha256.to_string())
        .collect()
}

fn installed_manifest(
    spec: RuntimeSpec,
    acceleration: RuntimeAcceleration,
) -> Option<(RuntimeManifest, PathBuf)> {
    let target = install_root().ok()?.join(spec.id);
    let manifest_path = target.join("manifest.json");
    let manifest: RuntimeManifest =
        serde_json::from_str(&fs::read_to_string(manifest_path).ok()?).ok()?;
    if manifest.runtime != spec.id
        || manifest.version != spec.version
        || manifest.acceleration != acceleration
        || manifest.archives != archive_hashes(archives_for(spec, acceleration))
    {
        return None;
    }
    let executable = target.join(&manifest.executable);
    executable.is_file().then_some((manifest, executable))
}

fn any_installed_manifest(spec: RuntimeSpec) -> Option<(RuntimeManifest, PathBuf)> {
    let target = install_root().ok()?.join(spec.id);
    let manifest: RuntimeManifest =
        serde_json::from_str(&fs::read_to_string(target.join("manifest.json")).ok()?).ok()?;
    if manifest.runtime != spec.id || manifest.version != spec.version {
        return None;
    }
    let executable = target.join(&manifest.executable);
    executable.is_file().then_some((manifest, executable))
}

pub(crate) fn installed_executable(runtime: &str) -> Option<PathBuf> {
    let spec = runtime_spec(runtime).ok()?;
    any_installed_manifest(spec).map(|(_, executable)| executable)
}

pub(crate) fn installed_acceleration(runtime: &str) -> Option<String> {
    let spec = runtime_spec(runtime).ok()?;
    any_installed_manifest(spec)
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

fn cuda_available() -> bool {
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
        for line in text.lines().filter(|line| !line.trim().is_empty()) {
            let fields = line.split(',').map(str::trim).collect::<Vec<_>>();
            let driver_major = fields
                .first()
                .and_then(|value| value.split('.').next())
                .and_then(|value| value.parse::<u32>().ok())
                .unwrap_or(0);
            let compute_cap = fields
                .get(1)
                .and_then(|value| value.parse::<f32>().ok())
                .unwrap_or(5.0);
            if driver_major >= 551 && compute_cap >= 5.0 {
                return true;
            }
        }
    }
    false
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
    }
}

#[tauri::command]
pub async fn ensure_local_runtime(runtime: String) -> Result<RuntimeInstallResult, String> {
    let spec = runtime_spec(&runtime)?;
    let acceleration = if cuda_available() {
        RuntimeAcceleration::Cuda
    } else {
        RuntimeAcceleration::Vulkan
    };
    if let Some((manifest, executable)) = installed_manifest(spec, acceleration) {
        return Ok(installed_result(spec, manifest, executable, true));
    }

    let lock = INSTALL_LOCK.get_or_init(|| Mutex::new(()));
    let _guard = lock.lock().await;
    if let Some((manifest, executable)) = installed_manifest(spec, acceleration) {
        return Ok(installed_result(spec, manifest, executable, true));
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
            .get(archive.download_url)
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
        if actual_sha256 != archive.sha256 {
            remove_if_present(&archive_path)?;
            return Err(format!(
                "Runtime checksum mismatch for {}: expected {}, got {}",
                archive.name, archive.sha256, actual_sha256
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
    let manifest = RuntimeManifest {
        runtime: spec.id.to_string(),
        version: spec.version.to_string(),
        acceleration,
        archives: archive_hashes(archives),
        executable: executable_relative.to_string_lossy().to_string(),
        installed_at: chrono::Utc::now().to_rfc3339(),
    };
    fs::write(
        staging.join("manifest.json"),
        serde_json::to_vec_pretty(&manifest).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
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
    fn writes_expected_manifest_shape() {
        let manifest = RuntimeManifest {
            runtime: "audio.cpp".to_string(),
            version: "v0.9.5".to_string(),
            acceleration: RuntimeAcceleration::Cuda,
            archives: vec!["a".repeat(64)],
            executable: "bin/audiocpp_server.exe".to_string(),
            installed_at: "2026-11-16T00:00:00Z".to_string(),
        };
        let value: serde_json::Value = serde_json::to_value(manifest).expect("manifest");
        assert_eq!(
            value
                .get("acceleration")
                .and_then(serde_json::Value::as_str),
            Some("cuda")
        );
    }
}
