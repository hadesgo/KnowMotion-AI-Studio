use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;

pub const WORKFLOW_KEY: &str = "knowledge-animation-v1";
pub const WORKFLOW_VERSION: &str = "1.0";

pub const AGENT_KEYS: [&str; 9] = [
    "research",
    "director",
    "script",
    "storyboard",
    "art_director",
    "asset",
    "animation",
    "audio",
    "quality",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDescriptor {
    pub key: String,
    pub title: String,
    pub description: String,
    pub version: String,
    pub capability: String,
    pub dependencies: Vec<String>,
    pub requires_approval: bool,
    pub approval_label: Option<String>,
    pub input_schema: Value,
    pub output_schema: Value,
    pub allowed_tools: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowDefinition {
    pub key: String,
    pub version: String,
    pub title: String,
    pub description: String,
    pub agents: Vec<AgentDescriptor>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConfig {
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentModelRoute {
    pub provider_id: String,
    pub model: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowStartRequest {
    pub project: Value,
    #[serde(default)]
    pub providers: Vec<ProviderConfig>,
    #[serde(default)]
    pub agent_routes: BTreeMap<String, AgentModelRoute>,
    pub instruction: Option<String>,
    pub max_attempts: Option<u32>,
    pub target_agent: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentInput {
    pub project: Value,
    pub instruction: Option<String>,
    pub dependency_outputs: BTreeMap<String, Value>,
    pub target_scene_ids: Vec<String>,
    pub agent_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentOutput {
    pub summary: String,
    #[serde(default)]
    pub changes: Vec<ProjectToolCall>,
    #[serde(default)]
    pub warnings: Vec<String>,
    #[serde(default)]
    pub needs_attention: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "tool", content = "input", rename_all = "camelCase")]
pub enum ProjectToolCall {
    SetResearchSources(ResearchSourcesInput),
    ReplaceOutline(OutlineInput),
    ReplaceScenes(ScenesInput),
    PatchScenes(ScenesInput),
    ReplaceAssets(AssetsInput),
    GenerateSceneAssets(GenerateAssetsInput),
    ReplaceTimeline(TimelineInput),
    ReplaceSubtitles(SubtitlesInput),
    UpdateSettings(SettingsInput),
    UpdateAudio(AudioInput),
    SetQualityReport(QualityReportInput),
    SetStage(StageInput),
}

impl ProjectToolCall {
    pub fn tool_name(&self) -> &'static str {
        match self {
            Self::SetResearchSources(_) => "setResearchSources",
            Self::ReplaceOutline(_) => "replaceOutline",
            Self::ReplaceScenes(_) => "replaceScenes",
            Self::PatchScenes(_) => "patchScenes",
            Self::ReplaceAssets(_) => "replaceAssets",
            Self::GenerateSceneAssets(_) => "generateSceneAssets",
            Self::ReplaceTimeline(_) => "replaceTimeline",
            Self::ReplaceSubtitles(_) => "replaceSubtitles",
            Self::UpdateSettings(_) => "updateSettings",
            Self::UpdateAudio(_) => "updateAudio",
            Self::SetQualityReport(_) => "setQualityReport",
            Self::SetStage(_) => "setStage",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResearchSourcesInput {
    pub sources: Vec<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutlineInput {
    pub sections: Vec<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScenesInput {
    pub scenes: Vec<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetsInput {
    pub assets: Vec<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetBrief {
    pub scene_id: String,
    #[serde(default)]
    pub title: String,
    pub prompt: String,
    #[serde(default)]
    pub style: String,
    #[serde(default = "default_asset_kind")]
    pub kind: String,
}

fn default_asset_kind() -> String {
    "illustration".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateAssetsInput {
    pub briefs: Vec<AssetBrief>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineInput {
    pub clips: Vec<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubtitlesInput {
    pub cues: Vec<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsInput {
    pub settings: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioInput {
    pub audio: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QualityReportInput {
    pub report: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StageInput {
    pub stage: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRevision {
    pub id: String,
    pub run_id: String,
    pub step_key: String,
    pub project_id: String,
    pub revision: i64,
    pub summary: String,
    pub created_at: String,
    pub undoable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowStepView {
    pub id: String,
    pub key: String,
    pub title: String,
    pub description: String,
    pub status: String,
    pub attempt: u32,
    pub max_attempts: u32,
    pub dependencies: Vec<String>,
    pub requires_approval: bool,
    pub approval_label: Option<String>,
    pub approval_status: String,
    pub provider_id: Option<String>,
    pub model: Option<String>,
    pub summary: Option<String>,
    pub warnings: Vec<String>,
    pub error: Option<String>,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRunView {
    pub id: String,
    pub project_id: String,
    pub workflow_key: String,
    pub status: String,
    pub current_step_key: Option<String>,
    pub instruction: Option<String>,
    pub error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub project: Option<Value>,
    pub steps: Vec<WorkflowStepView>,
    pub revisions: Vec<WorkflowRevision>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowEventPayload {
    pub event_id: String,
    pub run_id: String,
    pub step_key: Option<String>,
    pub kind: String,
    pub message: String,
    pub run_status: String,
    pub at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderTestRequest {
    pub provider: ProviderConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderTestResult {
    pub ok: bool,
    pub message: String,
    pub latency_ms: u128,
    pub model: String,
}

pub fn workflow_definition() -> WorkflowDefinition {
    WorkflowDefinition {
        key: WORKFLOW_KEY.to_string(),
        version: WORKFLOW_VERSION.to_string(),
        title: "知识动画完整创作流程".to_string(),
        description: "从研究到质量检查的持久化 Agent DAG，包含人工审批与项目修订。".to_string(),
        agents: vec![
            descriptor(
                "research",
                "Research Agent",
                "整理问题、核验需求、生成带不确定性标记的研究来源。",
                vec![],
                false,
                None,
                vec!["setResearchSources"],
            ),
            descriptor(
                "director",
                "Director Agent",
                "设计叙事策略、钩子、知识顺序与场景时长。",
                vec!["research"],
                true,
                Some("大纲审批"),
                vec!["replaceOutline"],
            ),
            descriptor(
                "script",
                "Script Agent",
                "把已批准大纲写成旁白、画面建议和镜头说明。",
                vec!["director"],
                false,
                None,
                vec!["replaceScenes"],
            ),
            descriptor(
                "storyboard",
                "Storyboard Agent",
                "拆分可制作的场景并补充镜头、转场和视觉需求。",
                vec!["script"],
                true,
                Some("分镜审批"),
                vec!["replaceScenes"],
            ),
            descriptor(
                "art_director",
                "Art Director Agent",
                "统一视觉风格，生成每个场景的画面方向与提示词。",
                vec!["storyboard"],
                false,
                None,
                vec!["replaceScenes", "updateSettings"],
            ),
            descriptor(
                "asset",
                "Asset Agent",
                "判断素材形式并创建可追溯的本地视觉草案。",
                vec!["art_director"],
                false,
                None,
                vec!["generateSceneAssets", "replaceAssets", "patchScenes"],
            ),
            descriptor(
                "animation",
                "Animation Agent",
                "生成结构化图层、时间点与镜头运动参数。",
                vec!["asset"],
                false,
                None,
                vec!["patchScenes"],
            ),
            descriptor(
                "audio",
                "Audio Agent",
                "生成旁白节奏、字幕时间线与音频配置。",
                vec!["animation"],
                false,
                None,
                vec!["replaceSubtitles", "replaceTimeline", "updateAudio"],
            ),
            descriptor(
                "quality",
                "Quality Agent",
                "检查事实风险、时长、素材、字幕和信息密度。",
                vec!["audio"],
                true,
                Some("最终内容审批"),
                vec!["setQualityReport"],
            ),
        ],
    }
}

fn descriptor(
    key: &str,
    title: &str,
    description: &str,
    dependencies: Vec<&str>,
    requires_approval: bool,
    approval_label: Option<&str>,
    allowed_tools: Vec<&str>,
) -> AgentDescriptor {
    AgentDescriptor {
        key: key.to_string(),
        title: title.to_string(),
        description: description.to_string(),
        version: "1.0".to_string(),
        capability: "LLM".to_string(),
        dependencies: dependencies.into_iter().map(str::to_string).collect(),
        requires_approval,
        approval_label: approval_label.map(str::to_string),
        input_schema: json!({
            "type": "object",
            "required": ["project", "instruction", "dependencyOutputs"],
            "properties": {
                "project": { "type": "object" },
                "instruction": { "type": ["string", "null"] },
                "dependencyOutputs": { "type": "object" },
                "targetSceneIds": { "type": "array", "items": { "type": "string" } }
            }
        }),
        output_schema: json!({
            "type": "object",
            "required": ["summary", "changes", "warnings"],
            "properties": {
                "summary": { "type": "string" },
                "changes": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "required": ["tool", "input"]
                    }
                },
                "warnings": { "type": "array", "items": { "type": "string" } },
                "needsAttention": { "type": "boolean" }
            }
        }),
        allowed_tools: allowed_tools.into_iter().map(str::to_string).collect(),
    }
}

pub fn common_output_contract(agent: &AgentDescriptor) -> String {
    format!(
        r#"你必须只返回一个 JSON 对象，不使用 Markdown 代码围栏：
{{
  "summary": "本次工作的简短说明",
  "changes": [
    {{"tool": "允许的工具名", "input": {{...}}}}
  ],
  "warnings": ["需要用户注意的风险"],
  "needsAttention": false
}}
你只允许调用这些项目工具：{}。
不得返回文件路径、shell 命令或任意代码。所有项目变更都会由运行时校验、记录并生成可撤销修订。
Agent: {} ({})"#,
        agent.allowed_tools.join(", "),
        agent.title,
        agent.key
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::{HashMap, HashSet};

    #[test]
    fn workflow_dependencies_are_acyclic() {
        let definition = workflow_definition();
        let descriptors: HashMap<_, _> = definition
            .agents
            .iter()
            .cloned()
            .map(|agent| (agent.key.clone(), agent))
            .collect();
        for agent in &definition.agents {
            for dependency in &agent.dependencies {
                assert!(descriptors.contains_key(dependency.as_str()));
            }
        }
        let mut visiting = HashSet::<String>::new();
        let mut visited = HashSet::<String>::new();
        fn visit(
            key: &str,
            descriptors: &HashMap<String, AgentDescriptor>,
            visiting: &mut HashSet<String>,
            visited: &mut HashSet<String>,
        ) {
            if visited.contains(key) {
                return;
            }
            assert!(
                visiting.insert(key.to_string()),
                "workflow contains a cycle at {key}"
            );
            if let Some(agent) = descriptors.get(key) {
                for dependency in &agent.dependencies {
                    visit(dependency, descriptors, visiting, visited);
                }
            }
            visiting.remove(key);
            visited.insert(key.to_string());
        }
        for agent in &definition.agents {
            visit(&agent.key, &descriptors, &mut visiting, &mut visited);
        }
    }

    #[test]
    fn every_agent_has_a_bounded_tool_allowlist() {
        for agent in workflow_definition().agents {
            assert!(!agent.allowed_tools.is_empty());
            assert!(agent.allowed_tools.len() <= 5);
            assert_eq!(agent.input_schema["type"], "object");
            assert_eq!(agent.output_schema["type"], "object");
        }
    }
}
