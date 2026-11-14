import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";
import { makeSampleProject } from "../../src/data/demo";
import VideoAssets from "../../src/pages/VideoAssets";
import { useStudioStore } from "../../src/store/studio";
import type { Asset } from "../../src/types";

const video: Asset = {
  id: "asset_video_clip",
  sceneId: "",
  name: "屏幕录制片段",
  kind: "video",
  src: "data:video/mp4;base64,AAAA",
  prompt: "用户导入视频",
  createdAt: "2026-11-14T00:00:00.000Z",
  local: true,
  durationMs: 12_000,
  width: 1920,
  height: 1080,
  mimeType: "video/mp4",
};

function renderPage(projectId: string) {
  return render(
    <MemoryRouter initialEntries={[`/projects/${projectId}/video`]}>
      <Routes>
        <Route path="/projects/:projectId/video" element={<VideoAssets />} />
        <Route path="/projects/:projectId/animation" element={<div>ANIMATION</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("VideoAssets workspace", () => {
  beforeEach(() => {
    const state = useStudioStore.getState();
    const project = makeSampleProject();
    project.assets = [video];
    useStudioStore.setState({
      projects: [project],
      providers: state.providers,
      taskRoutes: state.taskRoutes,
      toasts: [],
      assistantOpen: false,
    });
  });

  it("lists imported videos with duration and opens the clip editor", async () => {
    const user = userEvent.setup();
    const project = useStudioStore.getState().projects[0];
    renderPage(project.id);

    expect(await screen.findByText("视频素材 · 1")).toBeVisible();
    const card = screen.getByRole("button", { name: /屏幕录制片段/ });
    await user.click(card);

    expect(screen.getByText("CLIP EDITOR")).toBeVisible();
    expect(screen.getByLabelText("视频音量")).toBeInTheDocument();
    expect(screen.getAllByText(/0:12.0/).length).toBeGreaterThan(0);
  });

  it("inserts a trimmed clip into the selected scene", async () => {
    const user = userEvent.setup();
    const project = useStudioStore.getState().projects[0];
    renderPage(project.id);

    await user.click(await screen.findByRole("button", { name: /屏幕录制片段/ }));
    await user.click(screen.getByRole("button", { name: "插入当前镜头" }));

    await waitFor(() => {
      const updated = useStudioStore.getState().projects[0];
      const videoLayer = updated.scenes[0].layers.find(
        (layer) => layer.type === "video",
      );
      expect(videoLayer).toBeDefined();
      expect(videoLayer).toMatchObject({
        assetId: video.id,
        trimStart: 0,
        trimEnd: 12,
        fit: "cover",
        muted: true,
        playbackRate: 1,
      });
    });
    expect(useStudioStore.getState().toasts.at(-1)?.title).toBe(
      "已插入当前镜头",
    );
  });

  it("explains that importing requires the desktop runtime", async () => {
    const user = userEvent.setup();
    const project = useStudioStore.getState().projects[0];
    renderPage(project.id);

    await user.click(screen.getByRole("button", { name: "导入视频" }));
    expect(
      useStudioStore.getState().toasts.at(-1)?.title,
    ).toBe("导入视频需要桌面运行时");
  });
});
