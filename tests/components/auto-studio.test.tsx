import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";
import { makeSkyBlueProject } from "../../src/data/demo";
import AutoStudio from "../../src/pages/AutoStudio";
import { useStudioStore } from "../../src/store/studio";

describe("AutoStudio", () => {
  beforeEach(() => {
    const project = makeSkyBlueProject();
    useStudioStore.setState({
      projects: [project],
      toasts: [],
      assistantOpen: false,
    });
  });

  it("shows the one-prompt production pipeline in browser preview", () => {
    const project = useStudioStore.getState().projects[0];
    render(
      <MemoryRouter initialEntries={[`/projects/${project.id}/auto`]}>
        <Routes>
          <Route path="/projects/:projectId/auto" element={<AutoStudio />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(
      screen.getByRole("heading", {
        name: "让 AI 从一句话完成整支视频",
      }),
    ).toBeVisible();
    expect(screen.getByText("自动制作流水线")).toBeVisible();
    expect(screen.getByText("当前是浏览器预览")).toBeVisible();
    expect(screen.getByText("策划与分镜")).toBeVisible();
    expect(screen.getByText("渲染成片")).toBeVisible();
  });
});
