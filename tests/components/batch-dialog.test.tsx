import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { BatchImageDialog } from "../../src/components/BatchImageDialog";
import { createCharacter, makeSampleProject } from "../../src/data/demo";
import type { ImageGenerationRequestInput } from "../../src/services/capabilities";
import type { ProviderProfile, VideoProject } from "../../src/types";

const provider: ProviderProfile = {
  id: "provider-comfy",
  name: "Local ComfyUI",
  protocol: "ComfyUI",
  baseUrl: "http://127.0.0.1:8188",
  model: "sdxl.safetensors",
  capabilities: ["Image"],
  enabled: true,
  health: "healthy",
  hasSecret: false,
  isDefault: true,
};

function projectWithAnchors(): VideoProject {
  const project = makeSampleProject();
  const character = createCharacter("林博士", "解说者");
  character.appearance = "短卷发，圆框眼镜";
  project.characters = [character];
  project.scenes[0] = { ...project.scenes[0], characterIds: [character.id] };
  return project;
}

function renderDialog(project: VideoProject, enqueue: (requests: ImageGenerationRequestInput[]) => Promise<unknown>) {
  return render(
    <BatchImageDialog
      open
      onClose={() => undefined}
      project={project}
      provider={provider}
      style="电影感纪录片"
      size="1536x1024"
      useAnchors
      jobs={[]}
      onEnqueue={enqueue}
      onCancelJob={async () => undefined}
      onRetryJob={async () => undefined}
      onClearFinished={async () => undefined}
    />,
  );
}

describe("BatchImageDialog", () => {
  it("enqueues one request per selected scene with anchors applied", async () => {
    const user = userEvent.setup();
    const enqueue = vi.fn(async () => undefined);
    const project = projectWithAnchors();
    renderDialog(project, enqueue);

    expect(screen.getByText("镜头选择")).toBeVisible();
    expect(screen.getByText("5/5")).toBeVisible();

    await user.click(screen.getByRole("button", { name: /加入队列/ }));

    await waitFor(() => expect(enqueue).toHaveBeenCalledTimes(1));
    const requests = enqueue.mock.calls[0][0] as ImageGenerationRequestInput[];
    expect(requests).toHaveLength(project.scenes.length);
    expect(requests[0].sceneId).toBe(project.scenes[0].id);
    expect(requests[0].prompt).toContain("[CONSISTENCY LOCK]");
    expect(requests[0].anchorLabel).toBe("林博士");
    expect(requests[1].anchorLabel).toBe("");
    expect(requests.every((request) => request.size === "1536x1024")).toBe(true);
  });

  it("updates the planned count when a shot is deselected", async () => {
    const user = userEvent.setup();
    const enqueue = vi.fn(async () => undefined);
    renderDialog(makeSampleProject(), enqueue);

    const checkboxes = screen.getAllByRole("checkbox");
    await user.click(checkboxes[0]);
    expect(screen.getByText("4/5")).toBeVisible();
    expect(screen.getByRole("button", { name: "加入队列 · 4 张" })).toBeEnabled();
  });
});
