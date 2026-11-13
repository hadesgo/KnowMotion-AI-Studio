# 夜空知识动画示例

该示例由五个不同视觉策略的场景组成：

- Cinematic：电影感开场、图片、轨道 SVG 与推镜。
- Diagram：网格、波形和信息图布局。
- Data：结构化柱状/折线图。
- Editorial：图片与编辑部式文字层级。
- Minimal：极简文字和轨道收束。

生成 Composition：

```bash
npm run remotion:example
```

校验：

```bash
npm run remotion:validate
```

渲染：

```bash
npm run remotion:render -- --composition examples/night-sky/composition.json --out renders/night-sky.mp4
```
