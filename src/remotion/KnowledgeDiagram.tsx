import { useId } from "react";
import type { ReactNode } from "react";
import { Easing, interpolate } from "remotion";
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
    easing: Easing.out(Easing.cubic),
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
      <SvgText x="58" y="76" size="18" fill={MUTED} letterSpacing="2.5">
        原对话 / 只是这次推理的输入
      </SvgText>
      {conversation.map((text, index) => {
        const local = segment(frame, 4 + index * 13, 20);
        const y = 126 + index * 112;
        return (
          <g key={text} opacity={local * (1 - packed * 0.35)}>
            <rect
              x={54 + (index % 2) * 28}
              y={y}
              width={402 - (index % 2) * 28}
              height="78"
              rx="20"
              fill={index === 2 ? `${accent}22` : PANEL_RAISED}
              stroke={index === 2 ? accent : "#365057"}
              strokeWidth="1.2"
            />
            <circle
              cx={88 + (index % 2) * 28}
              cy={y + 39}
              r="6"
              fill={index === 2 ? accent : DIM}
            />
            <SvgText
              x={114 + (index % 2) * 28}
              y={y + 48}
              size="23"
              fill={index === 2 ? INK : "#c2d1d1"}
            >
              {text}
            </SvgText>
          </g>
        );
      })}

      <path
        d="M 462 342 C 514 342 516 342 558 342"
        fill="none"
        stroke={`url(#${id}-beam)`}
        strokeWidth="3"
        opacity={packed}
        strokeDasharray="180"
        strokeDashoffset={(1 - packed) * 180}
      />
      <g opacity={packed}>
        <rect
          x="478"
          y="306"
          width="168"
          height="74"
          rx="18"
          fill={`${accent}1f`}
          stroke={accent}
        />
        <SvgText x="562" y="337" size="17" fill={accent} anchor="middle">
          当前上下文
        </SvgText>
        <SvgText x="562" y="361" size="14" fill={MUTED} anchor="middle">
          拼接后的 token 序列
        </SvgText>
      </g>

      <g opacity={inference}>
        <path
          d="M 654 342 H 710"
          stroke={accent}
          strokeOpacity=".65"
          strokeWidth="2"
          strokeDasharray="8 7"
        />
        <rect
          x="724"
          y="184"
          width="402"
          height="286"
          rx="28"
          fill={`url(#${id}-panel)`}
          stroke="#35545a"
        />
        <SvgText x="756" y="226" size="17" fill={MUTED} letterSpacing="2">
          本次推理
        </SvgText>
        <SvgText x="756" y="276" size="27" weight={650}>
          读取 token
        </SvgText>
        <path d="M 756 298 H 1084" stroke="#365158" />
        <SvgText x="756" y="344" size="22" fill="#c4d2d2">
          位置 + 掩码 + 注意力
        </SvgText>
        <g transform="translate(756 374)">
          {["位置", "可见", "关联"].map((item, index) => (
            <g key={item} transform={`translate(${index * 104} 0)`}>
              <rect
                width="88"
                height="42"
                rx="11"
                fill={index === 2 ? `${accent}24` : "#15343a"}
                stroke={index === 2 ? accent : "#35545a"}
              />
              <SvgText x="44" y="27" size="16" anchor="middle">
                {item}
              </SvgText>
            </g>
          ))}
        </g>
        <circle
          cx="1042"
          cy="276"
          r="46"
          fill={accent}
          opacity=".12"
          filter={`url(#${id}-glow)`}
        />
        <circle cx="1042" cy="276" r="23" fill="none" stroke={accent} strokeWidth="2" />
        <circle cx="1042" cy="276" r="6" fill={accent} />
      </g>

      <g opacity={next} transform={`translate(${(1 - next) * 24} 0)`}>
        <path
          d="M 918 470 Q 918 556 744 556"
          fill="none"
          stroke={accent}
          strokeOpacity=".6"
          strokeWidth="2"
        />
        <rect
          x="572"
          y="520"
          width="344"
          height="74"
          rx="33"
          fill={`${accent}20`}
          stroke={accent}
        />
        <SvgText x="744" y="565" size="22" anchor="middle">
          生成下一个 token
        </SvgText>
      </g>
      <SvgText x="58" y="664" size="20" fill={MUTED}>
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
  const tokenWidth = 126;
  const gap = 16;
  const sourceX = (1200 - (tokens.length * tokenWidth + (tokens.length - 1) * gap)) / 2;
  const flow = segment(frame, 105, 30);
  return (
    <DiagramFrame id={id} accent={layer.accent}>
      <SvgText x="58" y="72" size="18" fill={MUTED} letterSpacing="2.4">
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
        <SvgText x="1110" y="126" size="14" fill={MUTED} anchor="end">
          连续字符，不是模型直接读取的单位
        </SvgText>
      </g>

      <SvgText x="58" y="246" size="18" fill={layer.accent} letterSpacing="2.4">
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
              height="104"
              rx="18"
              fill={index === tokens.length - 1 ? `${layer.accent}22` : PANEL_RAISED}
              stroke={index === tokens.length - 1 ? layer.accent : "#38555c"}
              strokeWidth="1.3"
            />
            <SvgText
              x={x + tokenWidth / 2}
              y="316"
              size="24"
              weight={600}
              anchor="middle"
              fill={index === tokens.length - 1 ? INK : "#d8e1df"}
            >
              {token}
            </SvgText>
            <SvgText
              x={x + tokenWidth / 2}
              y="346"
              size="14"
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
          d="M 66 426 H 1134"
          stroke={layer.accent}
          strokeOpacity=".45"
          strokeDasharray="8 10"
        />
        <path
          d="M 1100 426 L 1134 426 L 1118 414 M 1134 426 L 1118 438"
          fill="none"
          stroke={layer.accent}
          strokeWidth="2"
        />
        <SvgText x="600" y="412" size="17" fill={MUTED} anchor="middle">
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
                y="468"
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
                  y={558 - height * 64}
                  width="13"
                  height={height * 64}
                  rx="5"
                  fill={
                    columnIndex % 2 === 0 ? layer.accent : layer.secondaryColor
                  }
                  opacity={0.34 + height * 0.55}
                />
              ))}
              <SvgText x={x + tokenWidth / 2} y="490" size="14" fill={MUTED} anchor="middle">
                向量
              </SvgText>
            </g>
          );
        })}
      </g>
      <SvgText x="58" y="664" size="20" fill={MUTED}>
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
  const rowY = 108;
  const nodeW = 132;
  const gap = 20;
  const startX = (1200 - (nodes.length * nodeW + (nodes.length - 1) * gap)) / 2;
  const queryIndex = Math.min(nodes.length - 1, 4);
  const scores = [0.34, 0.53, 0.72, 0.45, 0.88, 0.64, 0.29];
  const qk = segment(frame, 118, 26);
  const mix = segment(frame, 176, 30);
  return (
    <DiagramFrame id={id} accent={layer.accent}>
      <SvgText x="58" y="72" size="18" fill={MUTED} letterSpacing="2.4">
        自注意力 / 一个简化计算过程
      </SvgText>
      {nodes.map((node, index) => {
        const x = startX + index * (nodeW + gap);
        const entered = segment(frame, 3 + index * 8, 18);
        const active = index === queryIndex;
        return (
          <g key={`${node}-${index}`} opacity={entered}>
            <path
              d={`M ${x + nodeW / 2} ${rowY + 74} C ${x + nodeW / 2} 222 ${600} 206 600 ${230}`}
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
              height="74"
              rx="18"
              fill={active ? `${layer.accent}22` : PANEL_RAISED}
              stroke={active ? layer.accent : "#38565c"}
            />
            <SvgText x={x + nodeW / 2} y={rowY + 46} size="22" anchor="middle">
              {node}
            </SvgText>
            <SvgText
              x={x + nodeW / 2}
              y={rowY - 12}
              size="14"
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
          x="300"
          y="230"
          width="600"
          height="82"
          rx="22"
          fill={`${layer.accent}18`}
          stroke={layer.accent}
        />
        <SvgText x="600" y="264" size="20" anchor="middle">
          Q × K → 相关权重
        </SvgText>
        <SvgText x="600" y="292" size="15" fill={MUTED} anchor="middle">
          权重经过归一化后，决定每一步读取多少线索
        </SvgText>
      </g>

      <g opacity={qk}>
        <rect
          x="42"
          y="332"
          width="1116"
          height="132"
          rx="22"
          fill={PANEL}
          stroke="#304b52"
        />
        <SvgText x="66" y="361" size="15" fill={MUTED} letterSpacing="1.5">
          注意力权重 / 相对大小示意
        </SvgText>
        {scores.slice(0, nodes.length).map((score, index) => {
          const x = startX + index * (nodeW + gap) + nodeW / 2;
          const barProgress = segment(frame, 96 + index * 6, 18);
          const barHeight = score * 54 * barProgress;
          return (
            <g key={`score-${index}`}>
              <rect
                x={x - 24}
                y={440 - barHeight}
                width="48"
                height={barHeight}
                rx="9"
                fill={index === queryIndex ? layer.accent : layer.secondaryColor}
                opacity={(0.25 + score * 0.6) * barProgress}
              />
              <SvgText
                x={x}
                y="456"
                size="14"
                fill={MUTED}
                anchor="middle"
                opacity={barProgress}
              >
                {score.toFixed(2)}
              </SvgText>
            </g>
          );
        })}
      </g>

      <g opacity={mix}>
        <path
          d="M 600 470 V 510"
          stroke={layer.accent}
          strokeWidth="2"
          strokeDasharray="7 6"
        />
        <path
          d="M 590 500 L 600 512 L 610 500"
          fill="none"
          stroke={layer.accent}
          strokeWidth="2"
        />
        <rect
          x="318"
          y="522"
          width="564"
          height="94"
          rx="24"
          fill={`url(#${id}-panel)`}
          stroke="#36545a"
        />
        <rect
          x="344"
          y="546"
          width="155"
          height="46"
          rx="14"
          fill="#102e35"
          stroke="#36545a"
        />
        <SvgText x="422" y="575" size="18" anchor="middle">
          权重 × V
        </SvgText>
        <path d="M 516 569 H 578" stroke={layer.accent} strokeWidth="2" />
        <path
          d="M 568 559 L 580 569 L 568 579"
          fill="none"
          stroke={layer.accent}
          strokeWidth="2"
        />
        <SvgText x="678" y="563" size="20">
          混合后的线索表示
        </SvgText>
        <SvgText x="678" y="586" size="14" fill={MUTED}>
          继续送往下一层计算
        </SvgText>
      </g>

      <SvgText x="58" y="664" size="20" fill={MUTED}>
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
  const tokenW = 122;
  const gap = 14;
  const startX = 70;
  const matrixSize = 318;
  const cell = matrixSize / tokens.length;
  const matrixX = 742;
  const matrixY = 266;
  const order = segment(frame, 20, 35);
  const mask = segment(frame, 126, 34);
  return (
    <DiagramFrame id={id} accent={layer.accent}>
      <SvgText x="58" y="72" size="18" fill={MUTED} letterSpacing="2.4">
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
              height="78"
              rx="18"
              fill={index === tokens.length - 1 ? `${layer.accent}21` : PANEL_RAISED}
              stroke={index === tokens.length - 1 ? layer.accent : "#37545b"}
            />
            <SvgText x={x + tokenW / 2} y="141" size="23" anchor="middle">
              {token}
            </SvgText>
            <SvgText x={x + tokenW / 2} y="168" size="14" fill={MUTED} anchor="middle">
              pos {String(index + 1).padStart(2, "0")}
            </SvgText>
          </g>
        );
      })}

      <g opacity={order}>
        <path
          d="M 86 208 H 986"
          stroke={layer.accent}
          strokeOpacity=".6"
          strokeWidth="2"
        />
        <path
          d="M 972 197 L 986 208 L 972 219"
          fill="none"
          stroke={layer.accent}
          strokeWidth="2"
        />
        <SvgText x="536" y="198" size="16" fill={layer.accent} anchor="middle">
          从左到右，顺序进入模型
        </SvgText>
        <rect
          x="70"
          y="250"
          width="500"
          height="292"
          rx="22"
          fill={PANEL}
          stroke="#304b52"
        />
        <SvgText x="96" y="290" size="20" weight={620}>
          位置编码 / 顺序可区分
        </SvgText>
        <g transform="translate(100 326)">
          {[1, 2, 3, 4, 5].map((position, index) => (
            <g key={position} transform={`translate(${index * 82} 0)`}>
              <rect
                width="58"
                height="58"
                rx="14"
                fill="#14343b"
                stroke={index === 3 ? layer.accent : "#37545b"}
              />
              <SvgText x="29" y="36" size="17" anchor="middle">
                P{position}
              </SvgText>
            </g>
          ))}
        </g>
        <SvgText x="96" y="430" size="18" weight={620}>
          因果掩码 / 哪些 token 可被读取？
        </SvgText>
        <g transform="translate(96 456)">
          {["过去", "当前", "未来"].map((label, index) => (
            <g key={label} transform={`translate(${index * 142} 0)`}>
              <circle
                cx="8"
                cy="12"
                r="7"
                fill={
                  index === 2 ? "#49606a" : index === 1 ? layer.accent : layer.secondaryColor
                }
              />
              <SvgText x="24" y="18" size="16" fill="#c6d2d2">
                {label}
              </SvgText>
              <SvgText x="24" y="43" size="14" fill={MUTED}>
                {index === 2 ? "被遮挡" : "可见"}
              </SvgText>
            </g>
          ))}
        </g>
      </g>

      <g opacity={0.75 + mask * 0.25}>
        <SvgText x={matrixX} y="210" size="18" fill={MUTED} letterSpacing="2">
          可见性矩阵
        </SvgText>
        <rect
          x="720"
          y="226"
          width="430"
          height="414"
          rx="22"
          fill={PANEL}
          stroke="#345159"
        />
        {tokens.map((_, row) =>
          tokens.map((__, column) => {
            const reveal = segment(
              frame,
              92 + row * 10,
              16,
            );
            const visible = column <= row;
            return (
              <g key={`${row}-${column}`} opacity={reveal}>
                <rect
                  x={matrixX + column * cell + 2}
                  y={matrixY + row * cell + 2}
                  width={cell - 4}
                  height={cell - 4}
                  rx="6"
                  fill={
                    !visible
                      ? "#0a171b"
                      : column === row
                        ? layer.accent
                        : layer.secondaryColor
                  }
                  opacity={
                    !visible
                      ? 0.8
                      : column === row
                        ? 0.9
                        : 0.28 + column * 0.04
                  }
                  stroke={!visible ? "#294047" : "none"}
                />
                {!visible && (
                  <path
                    d={`M ${matrixX + column * cell + 12} ${matrixY + row * cell + 12} L ${matrixX + (column + 1) * cell - 12} ${matrixY + (row + 1) * cell - 12}`}
                    stroke="#3a5157"
                    strokeWidth="1.4"
                    opacity=".55"
                  />
                )}
              </g>
            );
          }),
        )}
        {tokens.map((token, index) => (
          <g key={`matrix-label-${index}`}>
            <SvgText
              x={matrixX - 22}
              y={matrixY + index * cell + cell / 2 + 5}
              size="14"
              fill={MUTED}
              anchor="end"
            >
              {index + 1}
            </SvgText>
            <SvgText
              x={matrixX + index * cell + cell / 2}
              y={matrixY + matrixSize + 26}
              size="14"
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
          y={matrixY + matrixSize + 50}
          size="14"
          fill={MUTED}
          anchor="end"
        >
          上方=被查询的位置 · 左侧=可读取的位置
        </SvgText>
      </g>
      <SvgText x="58" y="670" size="20" fill={MUTED}>
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
      <SvgText x="58" y="72" size="18" fill={MUTED} letterSpacing="2.4">
        上下文窗口 / 窗口大小因模型与配置而异
      </SvgText>
      <g transform={`translate(${-sliding * 42} 0)`}>
        {tokens.map((token, index) => {
          const x = startX + index * (cardW + gap);
          const inside = x >= windowX && x + cardW <= windowX + windowW;
          const faded = !inside ? 1 - Math.max(0, sliding) * 0.45 : 1;
          return (
            <g key={`${token}-${index}`} opacity={segment(frame, 3 + index * 5, 16) * faded}>
              <rect
                x={x}
                y="190"
                width={cardW}
                height="122"
                rx="16"
                fill={inside ? `${layer.accent}1f` : PANEL_RAISED}
                stroke={inside ? layer.accent : "#38535a"}
                strokeOpacity={inside ? 0.8 : 0.45}
              />
              <SvgText x={x + cardW / 2} y="241" size="18" anchor="middle">
                {token}
              </SvgText>
              <SvgText x={x + cardW / 2} y="270" size="14" fill={MUTED} anchor="middle">
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
        <SvgText x={windowX + 95} y="151" size="15" fill="#07161b" weight={700} anchor="middle">
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
        <SvgText x="476" y="360" size="15" fill={layer.secondaryColor} anchor="middle">
          新输入进入
        </SvgText>
        <SvgText x="832" y="427" size="16" fill={MUTED} anchor="middle">
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
        <SvgText x="164" y="516" size="18" fill={MUTED}>
          模型没有自动获得“永久记忆”
        </SvgText>
        <SvgText x="164" y="547" size="22" fill="#d9e3e1">
          它只能基于当前窗口里可见的线索计算下一步
        </SvgText>
        <circle cx="1016" cy="522" r="26" fill={layer.accent} opacity=".12" />
        <circle cx="1016" cy="522" r="8" fill={layer.accent} />
      </g>
      <SvgText x="58" y="664" size="20" fill={MUTED}>
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
  const stepW = 196;
  const gap = 22;
  const startX = (1200 - (steps.length * stepW + (steps.length - 1) * gap)) / 2;
  const final = segment(frame, 145, 38);
  return (
    <DiagramFrame id={id} accent={layer.accent}>
      <SvgText x="58" y="72" size="18" fill={MUTED} letterSpacing="2.4">
        把整条机制连起来
      </SvgText>
      {steps.map((step, index) => {
        const x = startX + index * (stepW + gap);
        const local = segment(frame, 3 + index * 22, 24);
        return (
          <g key={step} opacity={local}>
            {index > 0 && (
              <path
                d={`M ${x - gap + 4} 234 H ${x - 7}`}
                stroke={layer.accent}
                strokeWidth="2"
                strokeOpacity={0.6}
                strokeDasharray="7 6"
              />
            )}
            <rect
              x={x}
              y="158"
              width={stepW}
              height="152"
              rx="24"
              fill={index === steps.length - 1 ? `${layer.accent}20` : PANEL_RAISED}
              stroke={index === steps.length - 1 ? layer.accent : "#38545b"}
            />
            <circle
              cx={x + 32}
              cy="192"
              r="18"
              fill={index === steps.length - 1 ? layer.accent : "#29454d"}
            />
            <SvgText
              x={x + 32}
              y="198"
              size="14"
              fill={index === steps.length - 1 ? "#06151a" : MUTED}
              anchor="middle"
              weight={700}
            >
              {index + 1}
            </SvgText>
            <SvgText x={x + stepW / 2} y="254" size="22" anchor="middle" weight={620}>
              {step}
            </SvgText>
            <SvgText
              x={x + stepW / 2}
              y="286"
              size="14"
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
          d="M 600 362 V 420"
          stroke={layer.accent}
          strokeWidth="2"
          strokeDasharray="7 7"
        />
        <path
          d="M 590 408 L 600 420 L 610 408"
          fill="none"
          stroke={layer.accent}
          strokeWidth="2"
        />
        <rect
          x="140"
          y="430"
          width="920"
          height="132"
          rx="30"
          fill={`url(#${id}-panel)`}
          stroke={layer.accent}
          strokeWidth="1.4"
        />
        <SvgText x="600" y="474" size="18" fill={layer.accent} anchor="middle" letterSpacing="2">
          一句可复述的结论
        </SvgText>
        <SvgText x="600" y="524" size="32" weight={680} anchor="middle">
          上下文 = 当前可读取、排序并加权的线索结构
        </SvgText>
      </g>
      <SvgText x="58" y="664" size="20" fill={MUTED}>
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
