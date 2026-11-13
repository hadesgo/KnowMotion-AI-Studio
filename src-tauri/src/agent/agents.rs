use super::model::{
    common_output_contract, workflow_definition, AgentDescriptor, AgentInput, AgentOutput,
};
use super::provider::{LlmProvider, LlmRequest};
use async_trait::async_trait;
use serde_json::Value;

#[async_trait]
pub trait Agent: Send + Sync {
    fn descriptor(&self) -> AgentDescriptor;
    async fn execute(
        &self,
        input: AgentInput,
        provider: &dyn LlmProvider,
        model: &str,
    ) -> Result<AgentExecution, String>;
}

pub struct AgentExecution {
    pub output: AgentOutput,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
}

pub struct AgentRegistry {
    descriptors: Vec<AgentDescriptor>,
}

impl AgentRegistry {
    pub fn new() -> Self {
        Self {
            descriptors: workflow_definition().agents,
        }
    }

    pub fn descriptors(&self) -> &[AgentDescriptor] {
        &self.descriptors
    }

    pub fn descriptor(&self, key: &str) -> Option<&AgentDescriptor> {
        self.descriptors.iter().find(|agent| agent.key == key)
    }

    pub async fn execute(
        &self,
        key: &str,
        input: AgentInput,
        provider: &dyn LlmProvider,
        model: &str,
    ) -> Result<AgentExecution, String> {
        match key {
            "research" => ResearchAgent.execute(input, provider, model).await,
            "director" => DirectorAgent.execute(input, provider, model).await,
            "script" => ScriptAgent.execute(input, provider, model).await,
            "storyboard" => StoryboardAgent.execute(input, provider, model).await,
            "art_director" => ArtDirectorAgent.execute(input, provider, model).await,
            "asset" => AssetAgent.execute(input, provider, model).await,
            "animation" => AnimationAgent.execute(input, provider, model).await,
            "audio" => AudioAgent.execute(input, provider, model).await,
            "quality" => QualityAgent.execute(input, provider, model).await,
            _ => Err(format!("Unknown agent: {key}")),
        }
    }
}

pub struct ResearchAgent;
pub struct DirectorAgent;
pub struct ScriptAgent;
pub struct StoryboardAgent;
pub struct ArtDirectorAgent;
pub struct AssetAgent;
pub struct AnimationAgent;
pub struct AudioAgent;
pub struct QualityAgent;

#[async_trait]
impl Agent for ResearchAgent {
    fn descriptor(&self) -> AgentDescriptor {
        descriptor("research")
    }

    async fn execute(
        &self,
        input: AgentInput,
        provider: &dyn LlmProvider,
        model: &str,
    ) -> Result<AgentExecution, String> {
        let descriptor = self.descriptor();
        let system = format!(
            r#"你是 KnowMotion 的 Research Agent。你负责为知识科普动画建立可核验的研究底稿。
不要虚构来源、作者、数据或结论。无法核验时应明确标注 verified=false，并在 note 中写明需要人工核验的内容。
只处理当前项目所需的主题问题。给出 3 到 8 条来源候选，并指出可能的事实风险。
{}

工具输入格式：
{{"tool":"setResearchSources","input":{{"sources":[{{"id":"source-id","title":"来源标题","url":"https://...","note":"与主题的关系及核验状态","verified":false}}]}}}}"#,
            common_output_contract(&descriptor)
        );
        run_structured(
            &descriptor,
            &input,
            provider,
            model,
            &system,
            "建立研究底稿，列出可靠来源候选与事实核验风险。",
        )
        .await
    }
}

#[async_trait]
impl Agent for DirectorAgent {
    fn descriptor(&self) -> AgentDescriptor {
        descriptor("director")
    }

    async fn execute(
        &self,
        input: AgentInput,
        provider: &dyn LlmProvider,
        model: &str,
    ) -> Result<AgentExecution, String> {
        let descriptor = self.descriptor();
        let system = format!(
            r#"你是 KnowMotion 的 Director Agent。你负责把研究结果转成适合动画观看的知识叙事结构。
结构必须有吸引力、逻辑清楚、尊重事实，并遵守项目目标时长。禁止把未核实内容说成事实。
返回完整的大纲替换，不要只返回差异。
{}

工具输入格式：
{{"tool":"replaceOutline","input":{{"sections":[{{"id":"unique-id","eyebrow":"01 · HOOK","title":"段落标题","body":"段落目标与画面方向","seconds":5}}]}}}}"#,
            common_output_contract(&descriptor)
        );
        run_structured(
            &descriptor,
            &input,
            provider,
            model,
            &system,
            "设计 4 到 8 段知识动画叙事结构，时间总和应接近目标时长。",
        )
        .await
    }
}

#[async_trait]
impl Agent for ScriptAgent {
    fn descriptor(&self) -> AgentDescriptor {
        descriptor("script")
    }

    async fn execute(
        &self,
        input: AgentInput,
        provider: &dyn LlmProvider,
        model: &str,
    ) -> Result<AgentExecution, String> {
        let descriptor = self.descriptor();
        let system = format!(
            r##"你是 KnowMotion 的 Script Agent。把已批准大纲写成可朗读、可视化的场景脚本。
每个场景必须只有一个主要理解动作。旁白自然、具体、不过度夸张。每场都要有 visualPrompt 与 description。
返回完整 scenes 数组。保留已有场景 id 可以表达增量编辑；新增场景使用新的唯一 id。
{}

工具输入格式：
{{"tool":"replaceScenes","input":{{"scenes":[{{"id":"scene-id","title":"场景标题","narration":"完整旁白","description":"画面描述","visualPrompt":"视觉提示词","shotType":"Explainer","transition":"柔光淡入","duration":6,"accent":"#c8ff65","layers":[]}}]}}}}"##,
            common_output_contract(&descriptor)
        );
        run_structured(
            &descriptor,
            &input,
            provider,
            model,
            &system,
            "把当前大纲写成完整知识动画脚本，时长贴近项目目标。",
        )
        .await
    }
}

#[async_trait]
impl Agent for StoryboardAgent {
    fn descriptor(&self) -> AgentDescriptor {
        descriptor("storyboard")
    }

    async fn execute(
        &self,
        input: AgentInput,
        provider: &dyn LlmProvider,
        model: &str,
    ) -> Result<AgentExecution, String> {
        let descriptor = self.descriptor();
        let system = format!(
            r##"你是 KnowMotion 的 Storyboard Agent。把脚本拆成可独立制作的视觉场景。
为每镜指定 shotType、transition、画面描述和视觉素材需求。一个场景只表达一个信息动作，时长要与旁白匹配。
返回完整 scenes 数组，并保持场景顺序。
{}

工具输入格式：
{{"tool":"replaceScenes","input":{{"scenes":[{{"id":"scene-id","title":"标题","narration":"旁白","description":"构图、主体、信息层级","visualPrompt":"可复用视觉提示词","shotType":"Diagram","transition":"横向推移","duration":6,"accent":"#79a9ff","layers":[]}}]}}}}"##,
            common_output_contract(&descriptor)
        );
        run_structured(
            &descriptor,
            &input,
            provider,
            model,
            &system,
            "完善分镜，明确每镜的构图、镜头、转场和视觉需求。",
        )
        .await
    }
}

#[async_trait]
impl Agent for ArtDirectorAgent {
    fn descriptor(&self) -> AgentDescriptor {
        descriptor("art_director")
    }

    async fn execute(
        &self,
        input: AgentInput,
        provider: &dyn LlmProvider,
        model: &str,
    ) -> Result<AgentExecution, String> {
        let descriptor = self.descriptor();
        let system = format!(
            r#"你是 KnowMotion 的 Art Director Agent。为整支知识动画建立一致但不过度重复的视觉方向。
优先选择矢量图形、信息图、图表和程序化构图；只有确实需要时才建议 AI 图片。
你会返回 updateSettings 统一风格，并返回完整 scenes 数组为每镜补充准确 visualPrompt、accent 与描述。
{}

工具输入格式：
{{"tool":"updateSettings","input":{{"settings":{{"style":"视觉风格名称"}}}}}}
{{"tool":"replaceScenes","input":{{"scenes":[...完整场景...]}}}}"#,
            common_output_contract(&descriptor)
        );
        run_structured(
            &descriptor,
            &input,
            provider,
            model,
            &system,
            "建立统一视觉语言，并为每个场景给出适合知识动画的视觉方向。",
        )
        .await
    }
}

#[async_trait]
impl Agent for AssetAgent {
    fn descriptor(&self) -> AgentDescriptor {
        descriptor("asset")
    }

    async fn execute(
        &self,
        input: AgentInput,
        provider: &dyn LlmProvider,
        model: &str,
    ) -> Result<AgentExecution, String> {
        let descriptor = self.descriptor();
        let system = format!(
            r#"你是 KnowMotion 的 Asset Agent。按镜头内容选择最合适的表现方式：
科学原理、数据、流程、物理结构和文字信息优先使用 vector、diagram、chart；
只有人物、复杂实景或艺术性插画才选择 illustration，并说明为什么需要位图。
当前 MVP 的 illustration 会生成可替换的本地 SVG 构图，不要声称已经调用在线图片模型。
使用 generateSceneAssets 提交素材草案；必要时使用 patchScenes 只更新目标场景的 visualMode 与 visualPrompt。
{}

工具输入格式：
{{"tool":"generateSceneAssets","input":{{"briefs":[{{"sceneId":"scene-id","title":"素材标题","prompt":"构图与视觉描述","style":"整体视觉风格","kind":"diagram|chart|vector|illustration"}}]}}}}
{{"tool":"patchScenes","input":{{"scenes":[{{"id":"scene-id","visualMode":"programmatic|image"}}]}}}}"#,
            common_output_contract(&descriptor)
        );
        run_structured(
            &descriptor,
            &input,
            provider,
            model,
            &system,
            "为每个场景规划并生成可用的本地视觉素材草案。",
        )
        .await
    }
}

#[async_trait]
impl Agent for AnimationAgent {
    fn descriptor(&self) -> AgentDescriptor {
        descriptor("animation")
    }

    async fn execute(
        &self,
        input: AgentInput,
        provider: &dyn LlmProvider,
        model: &str,
    ) -> Result<AgentExecution, String> {
        let descriptor = self.descriptor();
        let system = format!(
            r##"你是 KnowMotion 的 Animation Agent。你只能通过 patchScenes 修改动画配置。
如果用户指定了目标场景，只返回这些场景的 patch；如果目标场景为空，才为所有场景生成动画 patch。
绝对不要改写 id、title、narration、description、visualPrompt、duration 或 assetId。
你可以设置 layers、accent、transition、motionPreset。motionPreset 只能是 pushIn、pullOut、panLeft、panRight、none。
只使用 text 和 shape 图层；禁止生成代码、CSS、脚本或 Remotion 组件。
{}

工具输入格式：
{{"tool":"patchScenes","input":{{"scenes":[{{"id":"scene-id","accent":"#c8ff65","transition":"柔光淡入","motionPreset":"pushIn","layers":[{{"id":"layer-id","type":"text","name":"主标题","content":"...","x":8,"y":64,"width":70,"height":18,"opacity":1,"start":0,"end":6,"color":"#ffffff","fontSize":42}}]}}]}}}}"##,
            common_output_contract(&descriptor)
        );
        run_structured(
            &descriptor,
            &input,
            provider,
            model,
            &system,
            "为当前场景生成可编辑的文字和图形图层，并保证每场信息层级清楚。",
        )
        .await
    }
}

#[async_trait]
impl Agent for AudioAgent {
    fn descriptor(&self) -> AgentDescriptor {
        descriptor("audio")
    }

    async fn execute(
        &self,
        input: AgentInput,
        provider: &dyn LlmProvider,
        model: &str,
    ) -> Result<AgentExecution, String> {
        let descriptor = self.descriptor();
        let system = format!(
            r##"你是 KnowMotion 的 Audio Agent。根据最终场景旁白生成字幕时间线和音轨时间轴。
字幕必须逐字来自旁白，不得偷偷改写事实。时间从项目开头累计，片段不重叠。
同时给出适合当前项目的语音速率、音量和字幕位置。
{}

工具输入格式：
{{"tool":"replaceSubtitles","input":{{"cues":[{{"id":"cue-id","sceneId":"scene-id","start":0,"end":3.5,"text":"字幕文本"}}]}}}}
{{"tool":"replaceTimeline","input":{{"clips":[{{"id":"clip-id","track":"video","sceneId":"scene-id","label":"画面","start":0,"duration":6,"color":"#79a9ff"}},{{"id":"narr","track":"narration","sceneId":"scene-id","label":"旁白","start":0.2,"duration":5.5,"color":"#a78bfa"}}]}}}}
{{"tool":"updateAudio","input":{{"audio":{{"rate":0.94,"volume":0.82,"subtitleSize":32,"subtitlePosition":"bottom"}}}}}}"##,
            common_output_contract(&descriptor)
        );
        run_structured(
            &descriptor,
            &input,
            provider,
            model,
            &system,
            "生成字幕时间线、画面/旁白轨道和音频风格设置。",
        )
        .await
    }
}

#[async_trait]
impl Agent for QualityAgent {
    fn descriptor(&self) -> AgentDescriptor {
        descriptor("quality")
    }

    async fn execute(
        &self,
        input: AgentInput,
        provider: &dyn LlmProvider,
        model: &str,
    ) -> Result<AgentExecution, String> {
        let descriptor = self.descriptor();
        let system = format!(
            r#"你是 KnowMotion 的 Quality Agent。你负责在导出前审查内容和制作完整性。
检查事实风险、未核验来源、时长是否接近目标、场景信息密度、素材缺失、字幕覆盖与画幅一致性。
不要修改大纲、场景或素材。只通过 setQualityReport 写入结构化检查报告。
{}

工具输入格式：
{{"tool":"setQualityReport","input":{{"report":{{"score":0,"status":"pass|warn|fail","findings":[{{"severity":"info|warning|error","code":"...","message":"...","sceneId":"optional"}}],"checkedAt":"ISO timestamp","summary":"..."}}}}}}"#,
            common_output_contract(&descriptor)
        );
        run_structured(
            &descriptor,
            &input,
            provider,
            model,
            &system,
            "运行最终质量检查，并给出可执行的修改建议。",
        )
        .await
    }
}

async fn run_structured(
    descriptor: &AgentDescriptor,
    input: &AgentInput,
    provider: &dyn LlmProvider,
    model: &str,
    system: &str,
    task: &str,
) -> Result<AgentExecution, String> {
    let context = compact_project(&input.project);
    let user = format!(
        "{task}\n\n项目上下文：\n{}\n\n上游 Agent 结果：\n{}\n\n用户指令：{}\n目标场景：{}",
        context,
        serde_json::to_string_pretty(&input.dependency_outputs)
            .map_err(|error| error.to_string())?,
        input
            .instruction
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or("按照标准工作流继续。"),
        if input.target_scene_ids.is_empty() {
            "全部场景".to_string()
        } else {
            input.target_scene_ids.join(", ")
        }
    );
    let response = provider
        .complete(LlmRequest {
            model: model.to_string(),
            system: system.to_string(),
            user: user.clone(),
            temperature: 0.35,
            max_tokens: 6000,
            json_mode: true,
        })
        .await?;
    let output = parse_agent_output(&response.text)?;
    validate_output_tools(descriptor, &output)?;
    if output.summary.trim().is_empty() {
        return Err(format!("{} returned an empty summary", descriptor.title));
    }
    Ok(AgentExecution {
        output,
        input_tokens: response.input_tokens,
        output_tokens: response.output_tokens,
    })
}

fn parse_agent_output(text: &str) -> Result<AgentOutput, String> {
    let trimmed = text.trim();
    let without_fence = if trimmed.starts_with("```") {
        trimmed
            .lines()
            .skip(1)
            .take_while(|line| !line.trim().starts_with("```"))
            .collect::<Vec<_>>()
            .join("\n")
    } else {
        trimmed.to_string()
    };
    let start = without_fence
        .find('{')
        .ok_or_else(|| "Agent response contains no JSON object".to_string())?;
    let end = without_fence
        .rfind('}')
        .ok_or_else(|| "Agent response contains no complete JSON object".to_string())?;
    let json_slice = &without_fence[start..=end];
    serde_json::from_str::<AgentOutput>(json_slice)
        .map_err(|error| format!("Agent output does not match the structured schema: {error}"))
}

fn validate_output_tools(descriptor: &AgentDescriptor, output: &AgentOutput) -> Result<(), String> {
    if output.changes.len() > 30 {
        return Err("Agent requested too many project changes".to_string());
    }
    for change in &output.changes {
        if !descriptor
            .allowed_tools
            .iter()
            .any(|tool| tool == change.tool_name())
        {
            return Err(format!(
                "{} attempted an unauthorized tool: {}",
                descriptor.title,
                change.tool_name()
            ));
        }
    }
    if output.warnings.len() > 50 {
        return Err("Agent returned too many warnings".to_string());
    }
    Ok(())
}

fn compact_project(project: &Value) -> String {
    let mut compact = project.clone();
    if let Some(assets) = compact.get_mut("assets").and_then(Value::as_array_mut) {
        for asset in assets {
            if asset.get("src").is_some() {
                asset["src"] =
                    Value::String("[local asset omitted from model context]".to_string());
            }
        }
    }
    let serialized = serde_json::to_string(&compact).unwrap_or_else(|_| "{}".to_string());
    if serialized.len() > 120_000 {
        let compacted = serde_json::json!({
            "notice": "Project context was truncated to protect the model context window.",
            "settings": compact.get("settings"),
            "outline": compact.get("outline"),
            "scenes": compact.get("scenes"),
            "researchSources": compact.get("researchSources"),
            "qualityReport": compact.get("qualityReport")
        });
        serde_json::to_string(&compacted).unwrap_or_else(|_| "{}".to_string())
    } else {
        serialized
    }
}

fn descriptor(key: &str) -> AgentDescriptor {
    workflow_definition()
        .agents
        .into_iter()
        .find(|agent| agent.key == key)
        .expect("agent descriptor must exist")
}
