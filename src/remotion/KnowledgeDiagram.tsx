import { useId } from "react";
import type { ReactNode } from "react";
import { interpolate } from "remotion";
import type { DiagramLayerDsl } from "./schema";

const INK = "#f4f2e8";
const MUTED = "#9fb3b7";
const DIM = "#547077";
const PANEL = "#0d2429";
const PANEL_RAISED = "#123138";

function segment(frame: number, start: number, duration = 24): number {
  return interpolate(frame, [start, start + duration], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
}

function clampText(labels: string[], index: number, fallback: string): string {
  return labels[index]?.trim() || fallback;
}

function SvgText({
  x,
  y,
  children,
  size = 18,
  fill = INK,
  weight = 500,
  anchor = "start",
  opacity = 1,
  letterSpacing = 0,
}: {
  x: number | string;
  y: number | string;
  children: ReactNode;
  size?: number | string;
  fill?: string;
  weight?: number;
  anchor?: "start" | "middle" | "end";
  opacity?: number;
  letterSpacing?: number | string;
}) {
  return (
    <text
      x={x}
      y={y}
      fill={fill}
      fontFamily='"Microsoft YaHei UI", "Segoe UI", sans-serif'
      fontSize={size}
      fontWeight={weight}
      textAnchor={anchor}
      opacity={opacity}
      letterSpacing={letterSpacing}
    >
      {children}
    </text>
  );
}

function DiagramFrame({
  id,
  accent,
  children,
}: {
  id: string;
  accent: string;
  children: ReactNode;
}) {
  return (
    <svg
      viewBox="0 0 1200 700"
      width="100%"
      height="100%"
      role="img"
      aria-label="知识原理动画"
    >
      <defs>
        <linearGradient id={`${id}-panel`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={PANEL_RAISED} stopOpacity=".92" />
          <stop offset="1" stopColor={PANEL} stopOpacity=".74" />
        </linearGradient>
        <linearGradient id={`${id}-beam`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor={accent} stopOpacity="0" />
          <stop offset=".45" stopColor={accent} stopOpacity=".8" />
          <stop offset="1" stopColor={accent} stopOpacity="0" />
        </linearGradient>
        <filter id={`${id}-glow`} x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur stdDeviation="12" />
        </filter>
        <pattern
          id={`${id}-grid`}
          width="32"
          height="32"
          patternUnits="userSpaceOnUse"
        >
          <path
            d="M 32 0 L 0 0 0 32"
            fill="none"
            stroke="#8db3b8"
            strokeOpacity=".035"
            strokeWidth="1"
          />
        </pattern>
      </defs>
      <rect width="1200" height="700" fill={`url(#${id}-grid)`} />
      <circle cx="1070" cy="70" r="230" fill={accent} opacity=".045" />
      {children}
    </svg>
  );
}

function ContextBridge({
  layer,
  id,
  frame,
}: {
  layer: DiagramLayerDsl;
  id: string;
  frame: number;
}) {
  const accent = layer.accent;
  const labels = layer.labels;
  const conversation = [
    clampText(labels, 0, "明天去杭州"),
    clampText(labels, 1, "下午三点出发"),
    clampText(labels, 2, "帮我查路线"),
  ];
  const packed = segment(frame, 75, 28);
  const inference = segment(frame, 125, 34);
  const next = segment(frame, 190, 26);
  return (
    <DiagramFrame id={id} accent={accent}>
      <SvgText x="58" y="76" size="16" fill={MUTED} letterSpacing="2.5">
        原对话 / 只是这次推理的输入
      </SvgText>
      {conversation.map((text, index) => {
        const local = segment(frame, 4 + index * 13, 20);
        const y = 128 + index * 104;
        return (
          <g key={text} opacity={local * (1 - packed * 0.35)}>
            <rect
              x={64 + (index % 2) * 34}
              y={y}
              width={342 - (index % 2) * 34}
              height="68"
              rx="18"
              fill={index === 2 ? `${accent}22` : PANEL_RAISED}
              stroke={index === 2 ? accent : "#365057"}
              strokeWidth="1.2"
            />
            <circle
              cx={94 + (index % 2) * 34}
              cy={y + 34}
              r="5"
              fill={index === 2 ? accent : DIM}
            />
            <SvgText
              x={116 + (index % 2) * 34}
              y={y + 42}
              size="20"
              fill={index === 2 ? INK : "#c2d1d1"}
            >
              {text}
            </SvgText>
          </g>
        );
      })}

      <path
        d="M 440 328 C 504 328 506 328 558 328"
        fill="none"
        stroke={`url(#${id}-beam)`}
        strokeWidth="3"
        opacity={packed}
        strokeDasharray="180"
        strokeDashoffset={(1 - packed) * 180}
      />
      <g opacity={packed}>
        <rect
          x="506"
          y="292"
          width="112"
          height="72"
          rx="18"
          fill={`${accent}1f`}
          stroke={accent}
        />
        <SvgText x="562" y="323" size="16" fill={accent} anchor="middle">
          当前上下文
        </SvgText>
        <SvgText x="562" y="346" size="14" fill={MUTED} anchor="middle">
          拼接后的 token 序列
        </SvgText>
      </g>

      <g opacity={inference}>
        <path
          d="M 636 328 H 710"
          stroke={accent}
          strokeOpacity=".65"
          strokeWidth="2"
          strokeDasharray="8 7"
        />
        <rect
          x="728"
          y="198"
          width="382"
          height="258"
          rx="28"
          fill={`url(#${id}-panel)`}
          stroke="#35545a"
        />
        <SvgText x="760" y="238" size="15" fill={MUTED} letterSpacing="2">
          本次推理
        </SvgText>
        <SvgText x="760" y="284" size="25" weight={650}>
          读取 token
        </SvgText>
        <path d="M 760 306 H 1064" stroke="#365158" />
        <SvgText x="760" y="350" size="20" fill="#c4d2d2">
          位置 + 掩码 + 注意力
        </SvgText>
        <g transform="translate(760 380)">
          {["位置", "可见", "关联"].map((item, index) => (
            <g key={item} transform={`translate(${index * 104} 0)`}>
              <rect
                width="88"
                height="38"
                rx="11"
                fill={index === 2 ? `${accent}24` : "#15343a"}
                stroke={index === 2 ? accent : "#35545a"}
              />
              <SvgText x="44" y="25" size="15" anchor="middle">
                {item}
              </SvgText>
            </g>
          ))}
        </g>
        <circle
          cx="977"
          cy="288"
          r="46"
          fill={accent}
          opacity=".12"
          filter={`url(#${id}-glow)`}
        />
        <circle cx="977" cy="288" r="23" fill="none" stroke={accent} strokeWidth="2" />
        <circle cx="977" cy="288" r="6" fill={accent} />
      </g>

      <g opacity={next} transform={`translate(${(1 - next) * 24} 0)`}>
        <path
          d="M 918 468 Q 918 518 746 518"
          fill="none"
          stroke={accent}
          strokeOpacity=".6"
          strokeWidth="2"
        />
        <rect
          x="598"
          y="492"
          width="292"
          height="66"
          rx="33"
          fill={`${accent}20`}
          stroke={accent}
        />
        <SvgText x="744" y="532" size="20" anchor="middle">
          生成下一个 token
        </SvgText>
      </g>
      <SvgText x="58" y="640" size="18" fill={MUTED}>
        {layer.caption || "上下文是这次推理能读取的输入，不是自动长期保存的记忆。"}
      </SvgText>
    </DiagramFrame>
  );
}

function TokenSequence({
  layer,
  id,
  frame,
}: {
  layer: DiagramLayerDsl;
  id: string;
  frame: number;
}) {
  const labels = layer.labels;
  const sentence = clampText(
    labels,
    0,
    "明天去杭州，下午三点出发，帮我查路线",
  );
  const tokens = (
    labels.length > 1
      ? labels.slice(1)
      : ["明天", "去", "杭州", "下午", "三点", "出发", "查", "路线"]
  ).slice(0, 8);
  const tokenWidth = 116;
  const gap = 18;
  const sourceX = (1200 - (tokens.length * tokenWidth + (tokens.length - 1) * gap)) / 2;
  const flow = segment(frame, 105, 30);
  return (
    <DiagramFrame id={id} accent={layer.accent}>
      <SvgText x="58" y="72" size="16" fill={MUTED} letterSpacing="2.4">
        01 / 原始文本
      </SvgText>
      <g opacity={segment(frame, 2, 20)}>
        <rect
          x="58"
          y="98"
          width="1084"
          height="102"
          rx="22"
          fill={PANEL_RAISED}
          stroke="#355158"
        />
        <SvgText x="82" y="157" size="28" weight={620}>
          {sentence}
        </SvgText>
        <SvgText x="1110" y="126" size="13" fill={MUTED} anchor="end">
          连续字符，不是模型直接读取的单位
        </SvgText>
      </g>

      <SvgText x="58" y="246" size="16" fill={layer.accent} letterSpacing="2.4">
        02 / 分词器切成 token
      </SvgText>
      {tokens.map((token, index) => {
        const local = segment(frame, 26 + index * 8, 18);
        const x = sourceX + index * (tokenWidth + gap);
        return (
          <g key={`${token}-${index}`} opacity={local}>
            <path
              d={`M ${600} 202 C 600 220 ${x + tokenWidth / 2} 220 ${x + tokenWidth / 2} 260`}
              fill="none"
              stroke={index % 2 === 0 ? layer.accent : layer.secondaryColor}
              strokeOpacity=".24"
              strokeWidth="1.1"
              strokeDasharray="3 7"
              strokeDashoffset={(1 - local) * 40}
            />
            <rect
              x={x}
              y="264"
              width={tokenWidth}
              height="96"
              rx="18"
              fill={index === tokens.length - 1 ? `${layer.accent}22` : PANEL_RAISED}
              stroke={index === tokens.length - 1 ? layer.accent : "#38555c"}
              strokeWidth="1.3"
            />
            <SvgText
              x={x + tokenWidth / 2}
              y="310"
              size="23"
              weight={600}
              anchor="middle"
              fill={index === tokens.length - 1 ? INK : "#d8e1df"}
            >
              {token}
            </SvgText>
            <SvgText
              x={x + tokenWidth / 2}
              y="338"
              size="11"
              fill={MUTED}
              anchor="middle"
              letterSpacing="1.2"
            >
              T{String(index + 1).padStart(2, "0")}
            </SvgText>
          </g>
        );
      })}

      <g opacity={flow}>
        <path
          d="M 66 408 H 1134"
          stroke={layer.accent}
          strokeOpacity=".45"
          strokeDasharray="8 10"
        />
        <path
          d="M 1100 408 L 1134 408 L 1118 396 M 1134 408 L 1118 420"
          fill="none"
          stroke={layer.accent}
          strokeWidth="2"
        />
        <SvgText x="600" y="394" size="15" fill={MUTED} anchor="middle">
          转成向量后，模型才能计算
        </SvgText>
      </g>

      <g opacity={segment(frame, 140, 30)}>
        {tokens.map((token, index) => {
          const x = sourceX + index * (tokenWidth + gap);
          const columns = [0.45, 0.78, 0.36, 0.62];
          return (
            <g key={`embedding-${token}-${index}`}>
              <rect
                x={x}
                y="454"
                width={tokenWidth}
                height="112"
                rx="14"
                fill="#0b2025"
                stroke="#294650"
              />
              {columns.map((height, columnIndex) => (
                <rect
                  key={columnIndex}
                  x={x + 20 + columnIndex * 21}
                  y={545 - height * 64}
                  width="13"
                  height={height * 64}
                  rx="5"
                  fill={
                    columnIndex % 2 === 0 ? layer.accent : layer.secondaryColor
                  }
                  opacity={0.34 + height * 0.55}
                />
              ))}
              <SvgText x={x + 94} y="514" size="12" fill={MUTED} anchor="end">
                vector
              </SvgText>
            </g>
          );
        })}
      </g>
      <SvgText x="58" y="620" size="18" fill={MUTED}>
        {layer.caption ||
          "示意切分。真实 token 边界取决于模型使用的分词器，不一定等于一个汉字。"}
      </SvgText>
    </DiagramFrame>
  );
}

function AttentionMechanism({
  layer,
  id,
  frame,
}: {
  layer: DiagramLayerDsl;
  id: string;
  frame: number;
}) {
  const labels =
    layer.labels.length >= 6
      ? layer.labels
      : ["明天", "去", "杭州", "下午", "三点", "出发"];
  const nodes = labels.slice(0, 7);
  const rowY = 114;
  const nodeW = 126;
  const gap = 28;
  const startX = (1200 - (nodes.length * nodeW + (nodes.length - 1) * gap)) / 2;
  const queryIndex = Math.min(nodes.length - 1, 4);
  const scores = [0.34, 0.53, 0.72, 0.45, 0.88, 0.64, 0.29];
  const qk = segment(frame, 118, 26);
  const mix = segment(frame, 176, 30);
  return (
    <DiagramFrame id={id} accent={layer.accent}>
      <SvgText x="58" y="72" size="16" fill={MUTED} letterSpacing="2.4">
        自注意力 / 一个简化计算过程
      </SvgText>
      {nodes.map((node, index) => {
        const x = startX + index * (nodeW + gap);
        const entered = segment(frame, 3 + index * 8, 18);
        const active = index === queryIndex;
        return (
          <g key={`${node}-${index}`} opacity={entered}>
            <path
              d={`M ${x + nodeW / 2} ${rowY + 68} C ${x + nodeW / 2} 230 ${600} 212 600 ${232}`}
              fill="none"
              stroke={active ? layer.accent : layer.secondaryColor}
              strokeOpacity={active ? 0.58 : 0.15 + scores[index] * 0.36}
              strokeWidth={active ? 2.2 : 1}
              strokeDasharray="6 7"
              strokeDashoffset={(1 - qk) * 52}
            />
            <rect
              x={x}
              y={rowY}
              width={nodeW}
              height="68"
              rx="16"
              fill={active ? `${layer.accent}22` : PANEL_RAISED}
              stroke={active ? layer.accent : "#38565c"}
            />
            <SvgText x={x + nodeW / 2} y={rowY + 42} size="20" anchor="middle">
              {node}
            </SvgText>
            <SvgText
              x={x + nodeW / 2}
              y={rowY - 12}
              size="11"
              fill={MUTED}
              anchor="middle"
            >
              {active ? "当前 query" : `token ${String(index + 1).padStart(2, "0")}`}
            </SvgText>
          </g>
        );
      })}

      <g opacity={qk}>
        <rect
          x="368"
          y="232"
          width="464"
          height="78"
          rx="22"
          fill={`${layer.accent}18`}
          stroke={layer.accent}
        />
        <SvgText x="600" y="265" size="18" anchor="middle">
          Q × K → 相关权重
        </SvgText>
        <SvgText x="600" y="291" size="14" fill={MUTED} anchor="middle">
          权重经过归一化后，决定每一步读取多少线索
        </SvgText>
      </g>

      <g opacity={qk}>
        {scores.slice(0, nodes.length).map((score, index) => {
          const x = startX + index * (nodeW + gap) + nodeW / 2;
          const barHeight = score * 74;
          return (
            <g key={`score-${index}`}>
              <rect
                x={x - 22}
                y={376 - barHeight}
                width="44"
                height={barHeight}
                rx="9"
                fill={index === queryIndex ? layer.accent : layer.secondaryColor}
                opacity={0.25 + score * 0.6}
              />
              <SvgText x={x} y="398" size="12" fill={MUTED} anchor="middle">
                {score.toFixed(2)}
              </SvgText>
            </g>
          );
        })}
      </g>

      <g opacity={mix}>
        <path
          d="M 600 430 V 480"
          stroke={layer.accent}
          strokeWidth="2"
          strokeDasharray="7 6"
        />
        <path
          d="M 590 470 L 600 482 L 610 470"
          fill="none"
          stroke={layer.accent}
          strokeWidth="2"
        />
        <rect
          x="318"
          y="492"
          width="564"
          height="94"
          rx="24"
          fill={`url(#${id}-panel)`}
          stroke="#36545a"
        />
        <rect
          x="344"
          y="516"
          width="155"
          height="46"
          rx="14"
          fill="#102e35"
          stroke="#36545a"
        />
        <SvgText x="422" y="545" size="17" anchor="middle">
          权重 × V
        </SvgText>
        <path d="M 516 539 H 578" stroke={layer.accent} strokeWidth="2" />
        <path
          d="M 568 529 L 580 539 L 568 549"
          fill="none"
          stroke={layer.accent}
          strokeWidth="2"
        />
        <SvgText x="678" y="535" size="19">
          混合后的线索表示
        </SvgText>
        <SvgText x="678" y="559" size="13" fill={MUTED}>
          继续送往下一层计算
        </SvgText>
      </g>

      <SvgText x="58" y="642" size="18" fill={MUTED}>
        {layer.caption ||
          "线宽和数值仅用于示意。注意力权重是计算量，不等于可读的人类解释。"}
      </SvgText>
    </DiagramFrame>
  );
}

function PositionMask({
  layer,
  id,
  frame,
}: {
  layer: DiagramLayerDsl;
  id: string;
  frame: number;
}) {
  const tokens =
    layer.labels.length >= 6
      ? layer.labels.slice(0, 7)
      : ["明天", "去", "杭州", "下午", "三点", "出发", "查"];
  const tokenW = 132;
  const gap = 18;
  const startX = 76;
  const matrixSize = 360;
  const cell = matrixSize / tokens.length;
  const matrixX = 704;
  const matrixY = 140;
  const order = segment(frame, 20, 35);
  const mask = segment(frame, 126, 34);
  return (
    <DiagramFrame id={id} accent={layer.accent}>
      <SvgText x="58" y="72" size="16" fill={MUTED} letterSpacing="2.4">
        顺序与可见范围 / 自回归生成示意
      </SvgText>
      {tokens.map((token, index) => {
        const x = startX + index * (tokenW + gap);
        const local = segment(frame, 3 + index * 7, 16);
        return (
          <g key={`${token}-${index}`} opacity={local}>
            <rect
              x={x}
              y="104"
              width={tokenW}
              height="72"
              rx="16"
              fill={index === tokens.length - 1 ? `${layer.accent}21` : PANEL_RAISED}
              stroke={index === tokens.length - 1 ? layer.accent : "#37545b"}
            />
            <SvgText x={x + tokenW / 2} y="137" size="20" anchor="middle">
              {token}
            </SvgText>
            <SvgText x={x + tokenW / 2} y="160" size="12" fill={MUTED} anchor="middle">
              pos {String(index + 1).padStart(2, "0")}
            </SvgText>
            <path
              d={`M ${x + tokenW / 2} 184 C ${x + tokenW / 2} 220 ${x + tokenW / 2 + 38} 216 ${x + tokenW / 2 + 38} 244`}
              fill="none"
              stroke={layer.secondaryColor}
              strokeWidth="1.2"
              strokeOpacity={0.18 + order * 0.34}
              strokeDasharray="5 7"
            />
          </g>
        );
      })}

      <g opacity={order}>
        <path
          d="M 100 226 H 520"
          stroke={layer.accent}
          strokeOpacity=".6"
          strokeWidth="2"
        />
        <path
          d="M 506 215 L 520 226 L 506 237"
          fill="none"
          stroke={layer.accent}
          strokeWidth="2"
        />
        <SvgText x="310" y="211" size="15" fill={layer.accent} anchor="middle">
          位置编码保留前后顺序
        </SvgText>
        <rect
          x="76"
          y="260"
          width="520"
          height="182"
          rx="22"
          fill={PANEL}
          stroke="#304b52"
        />
        <SvgText x="104" y="301" size="18" weight={600}>
          注意力掩码：哪些 token 可被读取？
        </SvgText>
        <g transform="translate(104 330)">
          {["过去", "当前", "未来"].map((label, index) => (
            <g key={label} transform={`translate(${index * 150} 0)`}>
              <circle
                cx="8"
                cy="12"
                r="7"
                fill={
                  index === 2 ? "#49606a" : index === 1 ? layer.accent : layer.secondaryColor
                }
              />
              <SvgText x="24" y="18" size="15" fill="#c6d2d2">
                {label}
              </SvgText>
              <SvgText x="24" y="43" size="12" fill={MUTED}>
                {index === 2 ? "被遮挡" : "可见"}
              </SvgText>
            </g>
          ))}
        </g>
      </g>

      <g opacity={0.75 + mask * 0.25}>
        <SvgText x={matrixX} y="112" size="16" fill={MUTED} letterSpacing="2">
          可见性矩阵
        </SvgText>
        <rect
          x={matrixX - 12}
          y={matrixY - 12}
          width={matrixSize + 24}
          height={matrixSize + 68}
          rx="22"
          fill={PANEL}
          stroke="#345159"
        />
        {tokens.map((_, row) =>
          tokens.map((__, column) => {
            if (column > row) return null;
            const reveal = segment(
              frame,
              130 + (row * tokens.length + column) * 1.8,
              8,
            );
            return (
              <rect
                key={`${row}-${column}`}
                x={matrixX + column * cell + 2}
                y={matrixY + row * cell + 2}
                width={cell - 4}
                height={cell - 4}
                rx="6"
                fill={column === row ? layer.accent : layer.secondaryColor}
                opacity={reveal * (column === row ? 0.9 : 0.28 + column * 0.04)}
              />
            );
          }),
        )}
        {tokens.map((token, index) => (
          <g key={`matrix-label-${index}`}>
            <SvgText
              x={matrixX - 22}
              y={matrixY + index * cell + cell / 2 + 5}
              size="11"
              fill={MUTED}
              anchor="end"
            >
              {index + 1}
            </SvgText>
            <SvgText
              x={matrixX + index * cell + cell / 2}
              y={matrixY + matrixSize + 26}
              size="11"
              fill={MUTED}
              anchor="middle"
            >
              {index + 1}
            </SvgText>
            <title>
              {token} 对 {tokens[index]} 的可见性
            </title>
          </g>
        ))}
        <SvgText
          x={matrixX + matrixSize - 2}
          y={matrixY + matrixSize + 56}
          size="12"
          fill={MUTED}
          anchor="end"
        >
          上方=被查询的位置 · 左侧=可读取的位置
        </SvgText>
      </g>
      <SvgText x="58" y="626" size="18" fill={MUTED}>
        {layer.caption ||
          "位置编码补充顺序；因果掩码在预测下一个 token 时遮住未来信息。"}
      </SvgText>
    </DiagramFrame>
  );
}

function ContextWindow({
  layer,
  id,
  frame,
}: {
  layer: DiagramLayerDsl;
  id: string;
  frame: number;
}) {
  const labels =
    layer.labels.length >= 8
      ? layer.labels
      : ["旧对话", "设定", "问题", "资料", "引用", "限制", "目标", "格式", "当前"];
  const tokens = labels.slice(0, 12);
  const cardW = 86;
  const gap = 10;
  const startX = 46;
  const windowX = 554;
  const windowW = 532;
  const sliding = segment(frame, 102, 45);
  return (
    <DiagramFrame id={id} accent={layer.accent}>
      <SvgText x="58" y="72" size="16" fill={MUTED} letterSpacing="2.4">
        上下文窗口 / 窗口大小因模型与配置而异
      </SvgText>
      <g transform={`translate(${-sliding * 42} 0)`}>
        {tokens.map((token, index) => {
          const x = startX + index * (cardW + gap);
          const inside = x >= windowX && x + cardW <= windowX + windowW;
          const faded = !inside ? 1 - Math.max(0, sliding) * 0.7 : 1;
          return (
            <g key={`${token}-${index}`} opacity={segment(frame, 3 + index * 5, 16) * faded}>
              <rect
                x={x}
                y="190"
                width={cardW}
                height="116"
                rx="14"
                fill={inside ? `${layer.accent}1f` : PANEL_RAISED}
                stroke={inside ? layer.accent : "#38535a"}
                strokeOpacity={inside ? 0.8 : 0.45}
              />
              <SvgText x={x + cardW / 2} y="235" size="16" anchor="middle">
                {token}
              </SvgText>
              <SvgText x={x + cardW / 2} y="264" size="11" fill={MUTED} anchor="middle">
                T{String(index + 1).padStart(2, "0")}
              </SvgText>
            </g>
          );
        })}
      </g>

      <g opacity={segment(frame, 42, 26)}>
        <rect
          x={windowX}
          y="146"
          width={windowW}
          height="236"
          rx="26"
          fill="none"
          stroke={layer.accent}
          strokeWidth="3"
        />
        <rect
          x={windowX + 18}
          y="128"
          width="154"
          height="34"
          rx="17"
          fill={layer.accent}
        />
        <SvgText x={windowX + 95} y="151" size="14" fill="#07161b" weight={700} anchor="middle">
          本次可读取范围
        </SvgText>
        <path
          d={`M ${windowX - 24} 184 H ${windowX - 8} M ${windowX - 24} 344 H ${windowX - 8}`}
          stroke={layer.accent}
          strokeWidth="2"
        />
      </g>

      <g opacity={sliding}>
        <path
          d="M 485 318 Q 520 318 540 318"
          stroke={layer.secondaryColor}
          strokeWidth="2"
          strokeDasharray="7 6"
        />
        <path
          d="M 531 308 L 542 318 L 531 328"
          fill="none"
          stroke={layer.secondaryColor}
          strokeWidth="2"
        />
        <SvgText x="476" y="360" size="13" fill={layer.secondaryColor} anchor="middle">
          新输入进入
        </SvgText>
        <SvgText x="832" y="427" size="14" fill={MUTED} anchor="middle">
          旧内容移出后，不再属于本次可见上下文
        </SvgText>
      </g>

      <g opacity={segment(frame, 170, 24)}>
        <rect
          x="124"
          y="480"
          width="952"
          height="84"
          rx="22"
          fill={PANEL_RAISED}
          stroke="#345158"
        />
        <SvgText x="164" y="516" size="16" fill={MUTED}>
          模型没有自动获得“永久记忆”
        </SvgText>
        <SvgText x="164" y="544" size="20" fill="#d9e3e1">
          它只能基于当前窗口里可见的线索计算下一步
        </SvgText>
        <circle cx="1016" cy="522" r="26" fill={layer.accent} opacity=".12" />
        <circle cx="1016" cy="522" r="8" fill={layer.accent} />
      </g>
      <SvgText x="58" y="632" size="18" fill={MUTED}>
        {layer.caption ||
          "窗口容量有限；旧信息是否保留取决于产品如何截断、检索或压缩。"}
      </SvgText>
    </DiagramFrame>
  );
}

function ContextSummary({
  layer,
  id,
  frame,
}: {
  layer: DiagramLayerDsl;
  id: string;
  frame: number;
}) {
  const steps = (
    layer.labels.length >= 4
      ? layer.labels.slice(0, 5)
      : ["读取线索", "保留顺序", "计算关联", "限定范围", "组织成结构"]
  ).slice(0, 5);
  const stepW = 188;
  const gap = 34;
  const startX = (1200 - (steps.length * stepW + (steps.length - 1) * gap)) / 2;
  const final = segment(frame, 145, 38);
  return (
    <DiagramFrame id={id} accent={layer.accent}>
      <SvgText x="58" y="72" size="16" fill={MUTED} letterSpacing="2.4">
        把整条机制连起来
      </SvgText>
      {steps.map((step, index) => {
        const x = startX + index * (stepW + gap);
        const local = segment(frame, 3 + index * 22, 24);
        return (
          <g key={step} opacity={local}>
            {index > 0 && (
              <path
                d={`M ${x - gap + 3} 235 H ${x - 8}`}
                stroke={layer.accent}
                strokeWidth="2"
                strokeOpacity={0.6}
                strokeDasharray="7 6"
              />
            )}
            <rect
              x={x}
              y="164"
              width={stepW}
              height="144"
              rx="24"
              fill={index === steps.length - 1 ? `${layer.accent}20` : PANEL_RAISED}
              stroke={index === steps.length - 1 ? layer.accent : "#38545b"}
            />
            <circle
              cx={x + 32}
              cy="197"
              r="16"
              fill={index === steps.length - 1 ? layer.accent : "#29454d"}
            />
            <SvgText
              x={x + 32}
              y="202"
              size="12"
              fill={index === steps.length - 1 ? "#06151a" : MUTED}
              anchor="middle"
              weight={700}
            >
              {index + 1}
            </SvgText>
            <SvgText x={x + stepW / 2} y="255" size="20" anchor="middle" weight={600}>
              {step}
            </SvgText>
            <SvgText
              x={x + stepW / 2}
              y="283"
              size="12"
              fill={MUTED}
              anchor="middle"
            >
              {["输入进入模型", "信息不丢失顺序", "注意力分配权重", "窗口限制可见性", "下一步从这里生成"][index]}
            </SvgText>
          </g>
        );
      })}

      <g opacity={final} transform={`translate(0 ${(1 - final) * 22})`}>
        <path
          d="M 600 357 V 402"
          stroke={layer.accent}
          strokeWidth="2"
          strokeDasharray="7 7"
        />
        <path
          d="M 590 392 L 600 404 L 610 392"
          fill="none"
          stroke={layer.accent}
          strokeWidth="2"
        />
        <rect
          x="154"
          y="426"
          width="892"
          height="128"
          rx="30"
          fill={`url(#${id}-panel)`}
          stroke={layer.accent}
          strokeWidth="1.4"
        />
        <SvgText x="600" y="470" size="16" fill={layer.accent} anchor="middle" letterSpacing="2">
          一句可复述的结论
        </SvgText>
        <SvgText x="600" y="515" size="30" weight={680} anchor="middle">
          上下文 = 当前可读取、排序并加权的线索结构
        </SvgText>
      </g>
      <SvgText x="58" y="620" size="18" fill={MUTED}>
        {layer.caption ||
          "这里的“理解”是可计算的信息组织；是否等同于人类理解，是另一个问题。"}
      </SvgText>
    </DiagramFrame>
  );
}

export function KnowledgeDiagram({
  layer,
  frame,
}: {
  layer: DiagramLayerDsl;
  frame: number;
}) {
  const id = useId().replaceAll(":", "");
  if (layer.variant === "contextBridge") {
    return <ContextBridge layer={layer} id={id} frame={frame} />;
  }
  if (layer.variant === "tokenSequence") {
    return <TokenSequence layer={layer} id={id} frame={frame} />;
  }
  if (layer.variant === "attentionMechanism") {
    return <AttentionMechanism layer={layer} id={id} frame={frame} />;
  }
  if (layer.variant === "positionMask") {
    return <PositionMask layer={layer} id={id} frame={frame} />;
  }
  if (layer.variant === "contextWindow") {
    return <ContextWindow layer={layer} id={id} frame={frame} />;
  }
  return <ContextSummary layer={layer} id={id} frame={frame} />;
}
