import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";
import { makeSampleProject } from "../../src/data/demo";
import AudioSubtitles from "../../src/pages/AudioSubtitles";
import { useStudioStore } from "../../src/store/studio";
import type { ProviderProfile } from "../../src/types";

const fishProvider: ProviderProfile = {
  id: "provider-fish-audio",
  name: "Fish Audio",
  protocol: "Fish Audio",
  baseUrl: "https://api.fish.audio",
  model: "s2.1-pro-free",
  capabilities: ["TTS"],
  enabled: true,
  health: "healthy",
  hasSecret: true,
  isDefault: true,
};

describe("AudioSubtitles Fish Audio voice", () => {
  beforeEach(() => {
    const project = makeSampleProject();
    project.audio.voice = "系统中文语音";
    useStudioStore.setState({
      projects: [project],
      providers: [fishProvider],
      taskRoutes: { TTS: fishProvider.id },
      toasts: [],
    });
  });

  it("persists the project reference_id while it is being typed", async () => {
    const user = userEvent.setup();
    const project = useStudioStore.getState().projects[0];
    render(
      <MemoryRouter initialEntries={[`/projects/${project.id}/audio`]}>
        <Routes>
          <Route path="/projects/:projectId/audio" element={<AudioSubtitles />} />
        </Routes>
      </MemoryRouter>,
    );

    const input = await screen.findByPlaceholderText("输入 32 位 reference_id");
    await user.type(input, "e98fa6cdad6946bf8d9bb8f9cb8c2532");

    expect(input).toHaveValue("e98fa6cdad6946bf8d9bb8f9cb8c2532");
    expect(useStudioStore.getState().projects[0].audio.voice).toBe(
      "e98fa6cdad6946bf8d9bb8f9cb8c2532",
    );
  });
});
