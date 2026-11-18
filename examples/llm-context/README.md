# 大语言模型怎样理解上下文

这是对原成片的重做版本。视觉不再用抽象粒子或“素材草案”充当主画面，而是按讲解顺序拆成六个可读的机制：

1. 对话只是本次推理的输入，不是模型的永久记忆。
2. 文本先被分词器切成 token，再转成向量。
3. 注意力计算 token 之间的相关权重，并混合信息。
4. 位置编码保留顺序，因果掩码遮挡未来 token。
5. 上下文窗口限制一次推理能读取的范围。
6. 总结为“读取线索、保留顺序、计算关联、组织成结构”。

输出：

```text
renders/llm-context-v2.mp4
examples/llm-context/composition.json
examples/llm-context/project.json
examples/llm-context/audio/*.wav
```

旁白说明位于 `narration.json`。机制图由 `src/remotion/KnowledgeDiagram.tsx` 渲染；图中所有权重和 token 边界均标注为示意，避免把视觉辅助误读为特定模型的真实内部数据。
