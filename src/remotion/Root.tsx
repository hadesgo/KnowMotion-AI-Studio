import { Composition, getInputProps } from "remotion";
import { makeSampleProject } from "../data/demo";
import { KnowledgeComposition } from "./SceneRenderer";
import {
  buildProjectComposition,
  compositionSchema,
  type CompositionDsl,
} from "./schema";

interface RemotionInputProps extends Record<string, unknown> {
  composition?: CompositionDsl;
}

const fallback = buildProjectComposition(makeSampleProject());

export function RemotionRoot() {
  const input = getInputProps<RemotionInputProps>();
  const candidate = input.composition ?? fallback;
  const parsed = compositionSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new Error(
      `Invalid Remotion composition: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")}`,
    );
  }
  const composition = parsed.data;
  return (
    <Composition
      id="KnowledgeVideo"
      component={KnowledgeComposition}
      durationInFrames={composition.durationInFrames}
      fps={composition.fps}
      width={composition.width}
      height={composition.height}
      defaultProps={{ composition }}
    />
  );
}
