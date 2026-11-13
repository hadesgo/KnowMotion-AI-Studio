use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use crate::{logging, logging::LogLevel};
use chrono::Utc;
use hound::{SampleFormat, WavSpec, WavWriter};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::Arc,
};
use tauri::State;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedMediaAsset {
    pub id: String,
    pub scene_id: String,
    pub name: String,
    pub kind: String,
    pub src: String,
    pub prompt: String,
    pub created_at: String,
    pub local: bool,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NarrationRequest {
    pub project_id: String,
    pub scenes: Vec<Value>,
    pub voice: String,
    pub rate: f32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MusicRequest {
    pub project_id: String,
    pub duration_seconds: Option<u32>,
}

pub struct MediaService {
    projects_root: PathBuf,
    cache_root: PathBuf,
}

impl MediaService {
    pub fn new(projects_root: PathBuf, cache_root: PathBuf) -> Result<Arc<Self>, String> {
        fs::create_dir_all(&projects_root).map_err(|error| error.to_string())?;
        fs::create_dir_all(&cache_root).map_err(|error| error.to_string())?;
        Ok(Arc::new(Self {
            projects_root,
            cache_root,
        }))
    }

    fn project_root(&self, project_id: &str) -> Result<PathBuf, String> {
        if project_id.is_empty()
            || !project_id
                .chars()
                .all(|character| character.is_ascii_alphanumeric() || "-_".contains(character))
        {
            return Err("Invalid project id".to_string());
        }
        Ok(self.projects_root.join(project_id))
    }

    fn synthesize_narration(
        &self,
        project_id: &str,
        scene_id: &str,
        text: &str,
        voice: &str,
        rate: f32,
    ) -> Result<(PathBuf, u64), String> {
        let project_root = self.project_root(project_id)?;
        let output_directory = project_root.join("audio/narration");
        fs::create_dir_all(&output_directory).map_err(|error| error.to_string())?;
        let output = output_directory.join(format!("{scene_id}.wav"));
        let cache_directory = self.cache_root.join(format!("tts-{project_id}"));
        fs::create_dir_all(&cache_directory).map_err(|error| error.to_string())?;
        let text_path = cache_directory.join(format!("{scene_id}.txt"));
        let script_path = cache_directory.join("synthesize.ps1");
        fs::write(&text_path, text).map_err(|error| error.to_string())?;
        fs::write(
            &script_path,
            r#"param(
  [Parameter(Mandatory=$true)][string]$TextPath,
  [Parameter(Mandatory=$true)][string]$OutputPath,
  [string]$VoiceName = "",
  [int]$Rate = 0
)
Add-Type -AssemblyName System.Speech
$text = Get-Content -Raw -LiteralPath $TextPath
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  if ($VoiceName -ne "") {
    $voice = $synth.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Name -eq $VoiceName -and $_.Enabled } | Select-Object -First 1
    if ($null -ne $voice) { $synth.SelectVoice($voice.VoiceInfo.Name) }
  }
  $synth.Rate = [Math]::Max(-10, [Math]::Min(10, $Rate))
  $format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
  $synth.SetOutputToWaveFile($OutputPath, $format)
  $synth.Speak($text)
} finally {
  $synth.Dispose()
}"#,
        )
        .map_err(|error| error.to_string())?;
        let sapi_rate = (((rate.clamp(0.6, 1.4) - 1.0) * 30.0).round() as i32).clamp(-10, 10);
        let mut command = Command::new("powershell.exe");
        command
            .arg("-NoProfile")
            .arg("-NonInteractive")
            .arg("-ExecutionPolicy")
            .arg("Bypass")
            .arg("-File")
            .arg(&script_path)
            .arg("-TextPath")
            .arg(&text_path)
            .arg("-OutputPath")
            .arg(&output)
            .arg("-VoiceName")
            .arg(voice)
            .arg("-Rate")
            .arg(sapi_rate.to_string());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let result = command.output().map_err(|error| error.to_string())?;
        if !result.status.success() {
            return Err(format!(
                "Windows speech synthesis failed: {}",
                String::from_utf8_lossy(&result.stderr)
                    .chars()
                    .take(500)
                    .collect::<String>()
            ));
        }
        if !output.exists() {
            return Err("Speech synthesis did not create a WAV file".to_string());
        }
        let duration_ms = wav_duration_ms(&output)?;
        Ok((output, duration_ms))
    }

    fn generate_music(
        &self,
        project_id: &str,
        duration_seconds: u32,
    ) -> Result<(PathBuf, u64), String> {
        let project_root = self.project_root(project_id)?;
        let output_directory = project_root.join("audio/music");
        fs::create_dir_all(&output_directory).map_err(|error| error.to_string())?;
        let output = output_directory.join("ambient-knowledge-bed.wav");
        let sample_rate = 22_050;
        let seconds = duration_seconds.clamp(8, 30);
        let spec = WavSpec {
            channels: 1,
            sample_rate,
            bits_per_sample: 16,
            sample_format: SampleFormat::Int,
        };
        let mut writer = WavWriter::create(&output, spec).map_err(|error| error.to_string())?;
        let chords = [
            [220.0_f32, 277.18, 329.63],
            [196.0, 246.94, 293.66],
            [174.61, 220.0, 261.63],
            [196.0, 246.94, 329.63],
        ];
        let total_samples = sample_rate as u64 * seconds as u64;
        let chord_samples = total_samples / chords.len() as u64;
        for sample_index in 0..total_samples {
            let chord_index = ((sample_index / chord_samples) as usize).min(chords.len() - 1);
            let time = sample_index as f32 / sample_rate as f32;
            let fade = (sample_index as f32 / (sample_rate as f32 * 0.8)).clamp(0.0, 1.0)
                * (((total_samples - sample_index) as f32 / (sample_rate as f32 * 0.8))
                    .clamp(0.0, 1.0));
            let chord = chords[chord_index];
            let pad = chord
                .iter()
                .enumerate()
                .map(|(index, frequency)| {
                    (time * frequency * std::f32::consts::TAU + index as f32).sin() * 0.055
                })
                .sum::<f32>();
            let pulse = (time * 0.45 * std::f32::consts::TAU).sin().max(0.0) * 0.012;
            let value = ((pad + pulse) * fade * i16::MAX as f32) as i16;
            writer
                .write_sample(value)
                .map_err(|error| error.to_string())?;
        }
        writer.finalize().map_err(|error| error.to_string())?;
        let duration_ms = wav_duration_ms(&output)?;
        Ok((output, duration_ms))
    }
}

#[tauri::command]
pub async fn generate_project_narration(
    service: State<'_, Arc<MediaService>>,
    request: NarrationRequest,
) -> Result<Vec<GeneratedMediaAsset>, String> {
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut assets = Vec::new();
        for scene in request.scenes {
            let scene_id = scene
                .get("id")
                .and_then(Value::as_str)
                .ok_or_else(|| "Scene is missing id".to_string())?;
            let narration = scene
                .get("narration")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim();
            if narration.is_empty() {
                continue;
            }
            let title = scene.get("title").and_then(Value::as_str).unwrap_or("旁白");
            let (path, duration_ms) = service.synthesize_narration(
                &request.project_id,
                scene_id,
                narration,
                &request.voice,
                request.rate,
            )?;
            let bytes = fs::read(path).map_err(|error| error.to_string())?;
            assets.push(GeneratedMediaAsset {
                id: format!("narration-{scene_id}"),
                scene_id: scene_id.to_string(),
                name: format!("旁白 · {title}"),
                kind: "audio".to_string(),
                src: format!("data:audio/wav;base64,{}", BASE64.encode(bytes)),
                prompt: "Windows SAPI local speech synthesis".to_string(),
                created_at: Utc::now().to_rfc3339(),
                local: true,
                duration_ms,
            });
        }
        logging::log_event(
            LogLevel::Info,
            "media",
            "Local narration completed",
            Some(serde_json::json!({
                "projectId": request.project_id,
                "scenes": assets.len(),
                "voice": request.voice
            })),
        );
        Ok(assets)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn generate_background_music(
    service: State<'_, Arc<MediaService>>,
    request: MusicRequest,
) -> Result<GeneratedMediaAsset, String> {
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let (path, duration_ms) =
            service.generate_music(&request.project_id, request.duration_seconds.unwrap_or(15))?;
        let bytes = fs::read(path).map_err(|error| error.to_string())?;
        let asset = GeneratedMediaAsset {
            id: "music-ambient-knowledge-bed".to_string(),
            scene_id: "project".to_string(),
            name: "Ambient Knowledge Bed".to_string(),
            kind: "audio".to_string(),
            src: format!("data:audio/wav;base64,{}", BASE64.encode(bytes)),
            prompt: "Procedurally generated calm study background".to_string(),
            created_at: Utc::now().to_rfc3339(),
            local: true,
            duration_ms,
        };
        logging::log_event(
            LogLevel::Info,
            "media",
            "Background music completed",
            Some(serde_json::json!({
                "projectId": request.project_id,
                "durationMs": duration_ms
            })),
        );
        Ok(asset)
    })
    .await
    .map_err(|error| error.to_string())?
}

fn wav_duration_ms(path: &Path) -> Result<u64, String> {
    let reader = hound::WavReader::open(path).map_err(|error| error.to_string())?;
    let spec = reader.spec();
    let frames = reader.duration() as u64;
    Ok(frames * 1000 / spec.sample_rate.max(1) as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn procedural_music_is_a_real_audio_file() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let service = MediaService::new(
            directory.path().join("projects"),
            directory.path().join("cache"),
        )
        .expect("media service");
        let (path, duration_ms) = service
            .generate_music("project-test", 10)
            .expect("generate music");
        assert!(path.exists());
        assert!(fs::metadata(path).expect("metadata").len() > 100_000);
        assert!(duration_ms >= 9_000);
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "requires Windows SAPI outside the command sandbox"]
    fn windows_sapi_generates_narration_wav() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let service = MediaService::new(
            directory.path().join("projects"),
            directory.path().join("cache"),
        )
        .expect("media service");
        let (path, duration_ms) = service
            .synthesize_narration(
                "project-test",
                "scene-test",
                "天空是蓝色的。",
                "Microsoft Huihui Desktop",
                0.94,
            )
            .expect("Windows SAPI should generate a WAV file");
        assert!(path.exists());
        assert!(duration_ms > 500);
    }
}
