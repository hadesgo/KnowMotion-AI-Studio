use super::model::{AgentOutput, AssetBrief, ProjectToolCall, WorkflowRevision};
use crate::{mirror_project_files, write_atomic};
use chrono::Utc;
use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::path::Path;
use uuid::Uuid;

#[derive(Debug)]
pub struct AppliedChanges {
    pub project: Value,
    pub revision: WorkflowRevision,
    pub tools: Vec<String>,
}

pub fn apply_agent_changes(
    db: &mut Connection,
    projects_root: &Path,
    run_id: &str,
    step_key: &str,
    project_id: &str,
    before: &Value,
    output: &AgentOutput,
) -> Result<AppliedChanges, String> {
    let mut candidate = before.clone();
    let mut tools = Vec::new();
    for change in &output.changes {
        tools.push(change.tool_name().to_string());
        apply_change(&mut candidate, change)?;
    }
    candidate["updatedAt"] = Value::String(Utc::now().to_rfc3339());
    validate_project_shape(&candidate)?;

    let revision_id = Uuid::new_v4().to_string();
    let revision_number: i64 = db
        .query_row(
            "SELECT COALESCE(MAX(revision), 0) + 1 FROM project_revisions WHERE project_id = ?1",
            params![project_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    let created_at = Utc::now().to_rfc3339();
    let before_json = serde_json::to_string(before).map_err(|error| error.to_string())?;
    let after_json = serde_json::to_string(&candidate).map_err(|error| error.to_string())?;
    if before_json.len() + after_json.len() > 16 * 1024 * 1024 {
        return Err("Project revision exceeds the 16 MB safety limit".to_string());
    }

    let project_root = mirror_project_files(projects_root, &candidate)?;
    let revision_file = Path::new(&project_root)
        .join("revisions")
        .join(format!("{revision_number:04}-{step_key}.json"));
    let revision_document = json!({
        "id": revision_id,
        "runId": run_id,
        "stepKey": step_key,
        "projectId": project_id,
        "revision": revision_number,
        "summary": output.summary,
        "before": before,
        "after": candidate,
        "createdAt": created_at
    });
    write_atomic(
        &revision_file,
        &serde_json::to_vec_pretty(&revision_document).map_err(|error| error.to_string())?,
    )?;

    let transaction = db.transaction().map_err(|error| error.to_string())?;
    transaction
        .execute(
            r#"
            INSERT INTO project_revisions(
                id, run_id, step_id, project_id, revision, summary,
                before_json, after_json, undoable, created_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1, ?9)
            "#,
            params![
                revision_id,
                run_id,
                format!("{step_key}-{revision_number}"),
                project_id,
                revision_number,
                output.summary,
                before_json,
                after_json,
                created_at
            ],
        )
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "UPDATE workflow_runs SET project_json = ?1, updated_at = ?2 WHERE id = ?3",
            params![after_json, created_at, run_id],
        )
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())?;

    Ok(AppliedChanges {
        project: candidate,
        revision: WorkflowRevision {
            id: revision_id,
            run_id: run_id.to_string(),
            step_key: step_key.to_string(),
            project_id: project_id.to_string(),
            revision: revision_number,
            summary: output.summary.clone(),
            created_at,
            undoable: true,
        },
        tools,
    })
}

fn apply_change(project: &mut Value, change: &ProjectToolCall) -> Result<(), String> {
    match change {
        ProjectToolCall::SetResearchSources(input) => {
            project["researchSources"] = Value::Array(normalize_sources(&input.sources)?);
        }
        ProjectToolCall::ReplaceOutline(input) => {
            if input.sections.len() > 30 {
                return Err("Outline section limit is 30".to_string());
            }
            project["outline"] = Value::Array(normalize_outline(&input.sections)?);
            project["outlineApproved"] = Value::Bool(false);
        }
        ProjectToolCall::ReplaceScenes(input) => {
            if input.scenes.is_empty() || input.scenes.len() > 100 {
                return Err("Workflow requires between 1 and 100 scenes".to_string());
            }
            let scenes = input
                .scenes
                .iter()
                .enumerate()
                .map(|(index, scene)| normalize_scene(scene, index))
                .collect::<Result<Vec<_>, _>>()?;
            project["scenes"] = Value::Array(scenes);
        }
        ProjectToolCall::PatchScenes(input) => {
            patch_scenes(project, &input.scenes)?;
        }
        ProjectToolCall::ReplaceAssets(input) => {
            if input.assets.len() > 300 {
                return Err("Asset limit is 300".to_string());
            }
            let assets = input
                .assets
                .iter()
                .enumerate()
                .map(|(index, asset)| normalize_asset(asset, project, index))
                .collect::<Result<Vec<_>, _>>()?;
            project["assets"] = Value::Array(assets);
        }
        ProjectToolCall::GenerateSceneAssets(input) => {
            generate_assets(project, &input.briefs)?;
        }
        ProjectToolCall::ReplaceTimeline(input) => {
            if input.clips.len() > 500 {
                return Err("Timeline clip limit is 500".to_string());
            }
            let clips = input
                .clips
                .iter()
                .enumerate()
                .map(|(index, clip)| normalize_timeline_clip(clip, index))
                .collect::<Result<Vec<_>, _>>()?;
            project["timeline"] = Value::Array(clips);
        }
        ProjectToolCall::ReplaceSubtitles(input) => {
            if input.cues.len() > 800 {
                return Err("Subtitle cue limit is 800".to_string());
            }
            let cues = input
                .cues
                .iter()
                .enumerate()
                .map(|(index, cue)| normalize_subtitle(cue, index))
                .collect::<Result<Vec<_>, _>>()?;
            project["subtitles"] = Value::Array(cues);
        }
        ProjectToolCall::UpdateSettings(input) => {
            apply_settings(project, &input.settings)?;
        }
        ProjectToolCall::UpdateAudio(input) => {
            let current = project
                .get("audio")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            let patch = input
                .audio
                .as_object()
                .ok_or_else(|| "Audio update must be an object".to_string())?;
            let mut next = current;
            for key in [
                "voice",
                "rate",
                "volume",
                "subtitleSize",
                "subtitlePosition",
            ] {
                if let Some(value) = patch.get(key) {
                    next.insert(key.to_string(), value.clone());
                }
            }
            project["audio"] = Value::Object(next);
        }
        ProjectToolCall::SetQualityReport(input) => {
            project["qualityReport"] = input.report.clone();
        }
        ProjectToolCall::SetStage(input) => {
            let allowed = [
                "planning",
                "script",
                "storyboard",
                "assets",
                "animation",
                "timeline",
                "audio",
                "render",
            ];
            if !allowed.contains(&input.stage.as_str()) {
                return Err(format!("Unsupported project stage: {}", input.stage));
            }
            project["stage"] = Value::String(input.stage.clone());
        }
    }
    Ok(())
}

fn validate_project_shape(project: &Value) -> Result<(), String> {
    if !project.is_object() {
        return Err("Project must be a JSON object".to_string());
    }
    for field in ["id", "title", "settings"] {
        if project.get(field).is_none() {
            return Err(format!("Project is missing required field: {field}"));
        }
    }
    if !project["settings"].is_object() {
        return Err("Project settings must be an object".to_string());
    }
    Ok(())
}

fn normalize_outline(sections: &[Value]) -> Result<Vec<Value>, String> {
    sections
        .iter()
        .enumerate()
        .map(|(index, section)| {
            if !section.is_object() {
                return Err("Outline section must be an object".to_string());
            }
            let seconds = number(section, "seconds", 6.0).clamp(2.0, 120.0);
            Ok(json!({
                "id": text(section, "id", &format!("outline-{}", Uuid::new_v4())),
                "eyebrow": text(section, "eyebrow", &format!("{:02} · BEAT", index + 1)),
                "title": clip_text(&text(section, "title", "新的叙事段落"), 200),
                "body": clip_text(&text(section, "body", ""), 4000),
                "seconds": (seconds * 10.0).round() / 10.0
            }))
        })
        .collect()
}

fn normalize_sources(sources: &[Value]) -> Result<Vec<Value>, String> {
    if sources.len() > 50 {
        return Err("Research source limit is 50".to_string());
    }
    sources
        .iter()
        .map(|source| {
            if !source.is_object() {
                return Err("Research source must be an object".to_string());
            }
            Ok(json!({
                "id": text(source, "id", &format!("source-{}", Uuid::new_v4())),
                "title": clip_text(&text(source, "title", "未命名来源"), 300),
                "url": clip_text(&text(source, "url", ""), 2000),
                "note": clip_text(&text(source, "note", "待人工核验"), 2000),
                // Model output can propose sources, but only an explicit human action may verify them.
                "verified": false
            }))
        })
        .collect()
}

fn normalize_scene(scene: &Value, index: usize) -> Result<Value, String> {
    if !scene.is_object() {
        return Err("Scene must be an object".to_string());
    }
    let id = text(scene, "id", &format!("scene-{}", Uuid::new_v4()));
    let title = clip_text(&text(scene, "title", &format!("场景 {}", index + 1)), 200);
    let narration = clip_text(&text(scene, "narration", ""), 8000);
    let duration = number(scene, "duration", 6.0).clamp(1.0, 600.0);
    let accent = color(scene, "accent", "#c8ff65");
    let layers = scene
        .get("layers")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .take(30)
                .enumerate()
                .map(|(layer_index, layer)| normalize_layer(layer, &title, duration, layer_index))
                .collect::<Result<Vec<_>, String>>()
        })
        .transpose()?
        .filter(|items| !items.is_empty())
        .unwrap_or_else(|| {
            vec![json!({
                "id": format!("layer-{}", Uuid::new_v4()),
                "type": "text",
                "name": "主标题",
                "content": title,
                "x": 8,
                "y": 64,
                "width": 72,
                "height": 20,
                "opacity": 1,
                "start": 0,
                "end": duration,
                "color": "#f3f7f4",
                "fontSize": 46
            })]
        });
    Ok(json!({
        "id": id,
        "title": title,
        "narration": narration,
        "description": clip_text(&text(scene, "description", ""), 3000),
        "visualPrompt": clip_text(&text(scene, "visualPrompt", ""), 3000),
        "shotType": clip_text(&text(scene, "shotType", "Explainer"), 50),
        "transition": clip_text(&text(scene, "transition", "柔光淡入"), 80),
        "duration": (duration * 10.0).round() / 10.0,
        "accent": accent,
        "assetId": scene.get("assetId").cloned().unwrap_or(Value::Null),
        "motionPreset": scene
            .get("motionPreset")
            .and_then(Value::as_str)
            .filter(|value| ["pushIn", "pullOut", "panLeft", "panRight", "none"].contains(value))
            .unwrap_or("none"),
        "visualMode": if scene.get("visualMode").and_then(Value::as_str) == Some("image") {
            "image"
        } else {
            "programmatic"
        },
        "remotion": scene
            .get("remotion")
            .filter(|value| value.is_object())
            .cloned()
            .unwrap_or(Value::Null),
        "layers": layers
    }))
}

fn patch_scenes(project: &mut Value, patches: &[Value]) -> Result<(), String> {
    if patches.is_empty() || patches.len() > 30 {
        return Err("Scene patch requires between 1 and 30 scenes".to_string());
    }
    let scenes = project
        .get("scenes")
        .and_then(Value::as_array)
        .cloned()
        .ok_or_else(|| "Project has no scenes to patch".to_string())?;
    let protected = [
        "title",
        "narration",
        "description",
        "visualPrompt",
        "duration",
        "assetId",
    ];
    let mut matched = 0;
    let updated = scenes
        .iter()
        .enumerate()
        .map(|(index, scene)| {
            let scene_id = scene.get("id").and_then(Value::as_str).unwrap_or_default();
            let Some(patch) = patches
                .iter()
                .find(|patch| patch.get("id").and_then(Value::as_str) == Some(scene_id))
            else {
                return Ok(scene.clone());
            };
            matched += 1;
            let mut merged = scene.clone();
            if let (Some(base), Some(patch_object)) = (merged.as_object_mut(), patch.as_object()) {
                for (key, value) in patch_object {
                    base.insert(key.clone(), value.clone());
                }
            }
            let mut normalized = normalize_scene(&merged, index)?;
            for field in protected {
                normalized[field] = scene.get(field).cloned().unwrap_or(Value::Null);
            }
            Ok(normalized)
        })
        .collect::<Result<Vec<_>, String>>()?;
    if matched == 0 {
        return Err("Scene patch did not match any project scene".to_string());
    }
    project["scenes"] = Value::Array(updated);
    Ok(())
}

fn normalize_layer(
    layer: &Value,
    title: &str,
    duration: f64,
    index: usize,
) -> Result<Value, String> {
    if !layer.is_object() {
        return Err("Layer must be an object".to_string());
    }
    let layer_type = if text(layer, "type", "text") == "shape" {
        "shape"
    } else {
        "text"
    };
    Ok(json!({
        "id": text(layer, "id", &format!("layer-{}", Uuid::new_v4())),
        "type": layer_type,
        "name": clip_text(&text(layer, "name", if index == 0 { title } else { "图层" }), 120),
        "content": clip_text(&text(layer, "content", if index == 0 { title } else { "" }), 3000),
        "x": number(layer, "x", 8.0).clamp(-200.0, 200.0),
        "y": number(layer, "y", 64.0).clamp(-200.0, 200.0),
        "width": number(layer, "width", 70.0).clamp(0.1, 300.0),
        "height": number(layer, "height", 18.0).clamp(0.1, 300.0),
        "opacity": number(layer, "opacity", 1.0).clamp(0.0, 1.0),
        "start": number(layer, "start", 0.0).clamp(0.0, duration),
        "end": number(layer, "end", duration).clamp(0.0, duration),
        "color": color(layer, "color", "#f3f7f4"),
        "fontSize": number(layer, "fontSize", 42.0).clamp(8.0, 180.0),
        "shape": if layer_type == "shape" {
            Value::String(text(layer, "shape", "circle"))
        } else {
            Value::Null
        }
    }))
}

fn normalize_timeline_clip(clip: &Value, index: usize) -> Result<Value, String> {
    if !clip.is_object() {
        return Err("Timeline clip must be an object".to_string());
    }
    let track = text(clip, "track", "video");
    if !["video", "narration", "subtitle", "music", "sfx"].contains(&track.as_str()) {
        return Err(format!("Unsupported timeline track: {track}"));
    }
    Ok(json!({
        "id": text(clip, "id", &format!("clip-{}", Uuid::new_v4())),
        "track": track,
        "sceneId": clip.get("sceneId").cloned().unwrap_or(Value::Null),
        "label": clip_text(&text(clip, "label", &format!("片段 {}", index + 1)), 200),
        "start": number(clip, "start", 0.0).clamp(0.0, 86400.0),
        "duration": number(clip, "duration", 3.0).clamp(0.1, 86400.0),
        "color": color(clip, "color", "#79a9ff")
    }))
}

fn normalize_subtitle(cue: &Value, index: usize) -> Result<Value, String> {
    if !cue.is_object() {
        return Err("Subtitle cue must be an object".to_string());
    }
    let start = number(cue, "start", index as f64 * 3.0).max(0.0);
    let end = number(cue, "end", start + 3.0).max(start + 0.1);
    Ok(json!({
        "id": text(cue, "id", &format!("subtitle-{}", Uuid::new_v4())),
        "sceneId": text(cue, "sceneId", ""),
        "start": (start * 100.0).round() / 100.0,
        "end": (end * 100.0).round() / 100.0,
        "text": clip_text(&text(cue, "text", ""), 1000)
    }))
}

fn apply_settings(project: &mut Value, settings: &Value) -> Result<(), String> {
    let patch = settings
        .as_object()
        .ok_or_else(|| "Settings update must be an object".to_string())?;
    let current = project
        .get_mut("settings")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| "Project settings are missing".to_string())?;
    for key in [
        "topic",
        "contentType",
        "audience",
        "duration",
        "aspectRatio",
        "style",
        "language",
    ] {
        if let Some(value) = patch.get(key) {
            if key == "aspectRatio" && !matches!(value.as_str(), Some("16:9" | "9:16" | "1:1")) {
                return Err("Unsupported aspect ratio".to_string());
            }
            current.insert(key.to_string(), value.clone());
        }
    }
    Ok(())
}

fn generate_assets(project: &mut Value, briefs: &[AssetBrief]) -> Result<(), String> {
    if briefs.len() > 100 {
        return Err("Asset brief limit is 100".to_string());
    }
    let scene_ids = project
        .get("scenes")
        .and_then(Value::as_array)
        .map(|scenes| {
            scenes
                .iter()
                .filter_map(|scene| scene.get("id").and_then(Value::as_str))
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if scene_ids.is_empty() {
        return Err("Cannot generate assets before scenes exist".to_string());
    }
    let mut assets = project
        .get("assets")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut generated_by_scene = Vec::new();
    for (index, brief) in briefs.iter().enumerate() {
        let scene_id = if scene_ids.contains(&brief.scene_id) {
            brief.scene_id.clone()
        } else {
            scene_ids[index % scene_ids.len()].clone()
        };
        let (asset, accent) = svg_asset(&scene_id, brief, index);
        generated_by_scene.push((
            scene_id,
            asset["id"].as_str().unwrap_or_default().to_string(),
            accent,
            brief.kind.clone(),
        ));
        assets.push(asset);
    }
    project["assets"] = Value::Array(assets);
    if let Some(scenes) = project.get_mut("scenes").and_then(Value::as_array_mut) {
        for scene in scenes {
            let Some(scene_id) = scene.get("id").and_then(Value::as_str) else {
                continue;
            };
            if let Some((_, asset_id, accent, kind)) = generated_by_scene
                .iter()
                .find(|(id, _, _, _)| id == scene_id)
            {
                scene["assetId"] = Value::String(asset_id.clone());
                scene["accent"] = Value::String(accent.clone());
                scene["visualMode"] = Value::String(
                    if matches!(kind.as_str(), "illustration" | "photo") {
                        "image"
                    } else {
                        "programmatic"
                    }
                    .to_string(),
                );
            }
        }
    }
    Ok(())
}

fn normalize_asset(asset: &Value, project: &Value, index: usize) -> Result<Value, String> {
    if !asset.is_object() {
        return Err("Asset must be an object".to_string());
    }
    if asset.get("src").and_then(Value::as_str).is_some() {
        return Ok(json!({
            "id": text(asset, "id", &format!("asset-{}", Uuid::new_v4())),
            "sceneId": text(asset, "sceneId", ""),
            "name": clip_text(&text(asset, "name", &format!("素材 {}", index + 1)), 240),
            "kind": if text(asset, "kind", "image") == "audio" { "audio" } else { "image" },
            "src": clip_text(&text(asset, "src", ""), 2_500_000),
            "prompt": clip_text(&text(asset, "prompt", ""), 3000),
            "createdAt": text(asset, "createdAt", &Utc::now().to_rfc3339()),
            "local": true
        }));
    }
    let scene_id = text(asset, "sceneId", "");
    let scene = project
        .get("scenes")
        .and_then(Value::as_array)
        .and_then(|scenes| {
            scenes
                .iter()
                .find(|scene| scene.get("id").and_then(Value::as_str) == Some(scene_id.as_str()))
        })
        .cloned()
        .unwrap_or(Value::Null);
    let prompt = text(
        asset,
        "prompt",
        &text(&scene, "visualPrompt", "Knowledge animation visual"),
    );
    let brief = AssetBrief {
        scene_id,
        title: text(asset, "name", "视觉草案"),
        prompt,
        style: "Editorial science".to_string(),
        kind: "illustration".to_string(),
    };
    Ok(svg_asset(&brief.scene_id, &brief, index).0)
}

fn svg_asset(scene_id: &str, brief: &AssetBrief, index: usize) -> (Value, String) {
    let asset_id = format!("asset-{}", Uuid::new_v4());
    let palettes = ["#c8ff65", "#79a9ff", "#ffbc66", "#a78bfa"];
    let accent = palettes[index % palettes.len()].to_string();
    let title = escape_xml(&clip_text(&brief.title, 46));
    let prompt = escape_xml(&clip_text(&brief.prompt, 92));
    let style = escape_xml(&clip_text(&brief.style, 40));
    let svg = format!(
        r##"<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">
<defs><radialGradient id="g" cx="78%" cy="24%" r="85%"><stop offset="0" stop-color="{accent}" stop-opacity=".7"/><stop offset=".45" stop-color="#103943"/><stop offset="1" stop-color="#060b10"/></radialGradient></defs>
<rect width="1280" height="720" fill="url(#g)"/><circle cx="1010" cy="210" r="118" fill="none" stroke="{accent}" stroke-width="2" opacity=".6"/><circle cx="1010" cy="210" r="72" fill="none" stroke="{accent}" opacity=".3"/><circle cx="1010" cy="210" r="18" fill="{accent}"/>
<text x="82" y="70" fill="{accent}" font-family="Segoe UI, sans-serif" font-size="15" letter-spacing="4">ASSET AGENT / {style}</text>
<text x="82" y="490" fill="#f2f7f3" font-family="Segoe UI, sans-serif" font-size="48" font-weight="600">{title}</text>
<foreignObject x="84" y="520" width="760" height="90"><div xmlns="http://www.w3.org/1999/xhtml" style="color:#aab9c4;font:21px/1.5 'Segoe UI',sans-serif">{prompt}</div></foreignObject>
<rect x="82" y="640" width="110" height="3" fill="{accent}"/>
</svg>"##
    );
    let src = format!(
        "data:image/svg+xml;charset=utf-8,{}",
        utf8_percent_encode(&svg, NON_ALPHANUMERIC)
    );
    (
        json!({
            "id": asset_id,
            "sceneId": scene_id,
            "name": clip_text(&brief.title, 240),
            "kind": "image",
            "src": src,
            "prompt": clip_text(&brief.prompt, 3000),
            "createdAt": Utc::now().to_rfc3339(),
            "local": true
        }),
        accent,
    )
}

fn text(value: &Value, key: &str, fallback: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(fallback)
        .to_string()
}

fn number(value: &Value, key: &str, fallback: f64) -> f64 {
    value
        .get(key)
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
        .unwrap_or(fallback)
}

fn color(value: &Value, key: &str, fallback: &str) -> String {
    let candidate = text(value, key, fallback);
    if candidate.starts_with('#') && (candidate.len() == 7 || candidate.len() == 9) {
        candidate
    } else {
        fallback.to_string()
    }
}

fn clip_text(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

fn escape_xml(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

pub fn list_revisions(db: &Connection, run_id: &str) -> Result<Vec<WorkflowRevision>, String> {
    let mut statement = db
        .prepare(
            r#"
            SELECT id, run_id, step_id, project_id, revision, summary, created_at, undoable
            FROM project_revisions
            WHERE run_id = ?1
            ORDER BY revision DESC
            "#,
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![run_id], |row| {
            Ok(WorkflowRevision {
                id: row.get(0)?,
                run_id: row.get(1)?,
                step_key: row
                    .get::<_, String>(2)?
                    .split('-')
                    .next()
                    .unwrap_or("unknown")
                    .to_string(),
                project_id: row.get(3)?,
                revision: row.get(4)?,
                summary: row.get(5)?,
                created_at: row.get(6)?,
                undoable: row.get::<_, i64>(7)? == 1,
            })
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

pub fn undo_revision(
    db: &mut Connection,
    projects_root: &Path,
    revision_id: &str,
) -> Result<Value, String> {
    let (run_id, project_id, before_json, current_summary): (String, String, String, String) = db
        .query_row(
            "SELECT run_id, project_id, before_json, summary FROM project_revisions WHERE id = ?1",
            params![revision_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .map_err(|error| format!("Revision not found: {error}"))?;
    let before: Value = serde_json::from_str(&before_json).map_err(|error| error.to_string())?;
    let before_text = serde_json::to_string_pretty(&before).map_err(|error| error.to_string())?;
    let project_root = mirror_project_files(projects_root, &before)?;
    write_atomic(
        &Path::new(&project_root)
            .join("revisions")
            .join(format!("undo-{}.json", Uuid::new_v4())),
        before_text.as_bytes(),
    )?;

    let transaction = db.transaction().map_err(|error| error.to_string())?;
    transaction
        .execute(
            "UPDATE project_revisions SET undoable = 0 WHERE id = ?1",
            params![revision_id],
        )
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "UPDATE workflow_runs SET project_json = ?1, updated_at = ?2 WHERE id = ?3",
            params![before_text, Utc::now().to_rfc3339(), run_id],
        )
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())?;
    let _ = (project_id, current_summary);
    Ok(before)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn structured_tool_contract_deserializes() {
        let output: AgentOutput = serde_json::from_value(json!({
            "summary": "Updated outline",
            "changes": [{
                "tool": "replaceOutline",
                "input": {
                    "sections": [{
                        "id": "outline-1",
                        "eyebrow": "01 · HOOK",
                        "title": "A clear opening",
                        "body": "Explain the question",
                        "seconds": 5
                    }]
                }
            }],
            "warnings": [],
            "needsAttention": false
        }))
        .expect("structured output must deserialize");
        assert_eq!(output.changes.len(), 1);
        assert_eq!(output.changes[0].tool_name(), "replaceOutline");
    }

    #[test]
    fn rejects_unsupported_stage_without_mutating_scene_content() {
        let mut project = json!({
            "id": "project-test",
            "title": "Test",
            "settings": {},
            "scenes": []
        });
        let before = project.clone();
        let result = apply_change(
            &mut project,
            &ProjectToolCall::SetStage(super::super::model::StageInput {
                stage: "dangerous_stage".to_string(),
            }),
        );
        assert!(result.is_err());
        assert_eq!(project, before);
    }

    #[test]
    fn generated_assets_stay_local_and_attach_to_scene() {
        let mut project = json!({
            "id": "project-test",
            "title": "Test",
            "settings": {},
            "assets": [],
            "scenes": [{
                "id": "scene-1",
                "title": "Scene",
                "accent": "#c8ff65",
                "layers": []
            }]
        });
        apply_change(
            &mut project,
            &ProjectToolCall::GenerateSceneAssets(super::super::model::GenerateAssetsInput {
                briefs: vec![AssetBrief {
                    scene_id: "scene-1".to_string(),
                    title: "Orbital diagram".to_string(),
                    prompt: "A clean scientific orbit diagram".to_string(),
                    style: "Editorial".to_string(),
                    kind: "diagram".to_string(),
                }],
            }),
        )
        .expect("safe asset generation must succeed");
        let asset_src = project["assets"][0]["src"]
            .as_str()
            .expect("generated asset must have a data URL");
        assert!(asset_src.starts_with("data:image/svg+xml"));
        assert_eq!(project["scenes"][0]["assetId"], project["assets"][0]["id"]);
    }

    #[test]
    fn animation_patch_preserves_content_and_only_changes_requested_scene() {
        let mut project = json!({
            "id": "project-test",
            "title": "Test",
            "settings": {},
            "scenes": [
                {
                    "id": "scene-1",
                    "title": "First",
                    "narration": "First narration",
                    "description": "First visual",
                    "visualPrompt": "first prompt",
                    "duration": 5,
                    "layers": []
                },
                {
                    "id": "scene-2",
                    "title": "Second",
                    "narration": "Second narration",
                    "description": "Second visual",
                    "visualPrompt": "second prompt",
                    "duration": 6,
                    "layers": []
                }
            ]
        });
        let first_before = project["scenes"][0].clone();
        patch_scenes(
            &mut project,
            &[json!({
                "id": "scene-2",
                "narration": "This must not replace the existing narration",
                "title": "This must not replace the existing title",
                "motionPreset": "pushIn",
                "layers": [{
                    "id": "layer-push",
                    "type": "text",
                    "content": "Animated label",
                    "x": 20,
                    "y": 30,
                    "width": 40,
                    "height": 20,
                    "opacity": 1,
                    "start": 0,
                    "end": 6,
                    "color": "#ffffff",
                    "fontSize": 42
                }]
            })],
        )
        .expect("scene patch");
        assert_eq!(project["scenes"][0], first_before);
        assert_eq!(project["scenes"][1]["title"], "Second");
        assert_eq!(project["scenes"][1]["narration"], "Second narration");
        assert_eq!(project["scenes"][1]["motionPreset"], "pushIn");
    }
}
