import assert from "node:assert/strict";
import test from "node:test";
import { inferProjectIntent } from "../src/services/projectIntent";

test("infers a complete production brief from one sentence", () => {
  const intent = inferProjectIntent(
    "做一个 60 秒的竖屏科普视频，面向中学生，英文旁白，风格干净极简。",
  );

  assert.equal(intent.duration, 60);
  assert.equal(intent.aspectRatio, "9:16");
  assert.equal(intent.language, "English");
  assert.equal(intent.style, "编辑部极简");
  assert.match(intent.audience, /中学生/);
  assert.equal(intent.brief?.startsWith("做一个"), true);
});

test("fills sensible defaults for a short topic", () => {
  const intent = inferProjectIntent("为什么夜空是黑色的？");

  assert.equal(intent.aspectRatio, "16:9");
  assert.equal(intent.duration, 45);
  assert.equal(intent.contentType, "科学原理");
  assert.equal(intent.style, "电影感纪录片");
  assert.equal(intent.language, "简体中文");
});

test("explicit advanced settings override inference", () => {
  const intent = inferProjectIntent("解释大语言模型", {
    duration: 120,
    aspectRatio: "1:1",
    style: "未来主义数据",
  });

  assert.equal(intent.duration, 120);
  assert.equal(intent.aspectRatio, "1:1");
  assert.equal(intent.style, "未来主义数据");
  assert.equal(intent.contentType, "AI 技术");
});
