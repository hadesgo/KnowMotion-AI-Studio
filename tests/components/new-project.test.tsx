import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";
import NewProject from "../../src/pages/NewProject";
import { useStudioStore } from "../../src/store/studio";

describe("NewProject component flow", () => {
  beforeEach(() => {
    const state = useStudioStore.getState();
    useStudioStore.setState({
      projects: [],
      providers: state.providers,
      taskRoutes: state.taskRoutes,
      toasts: [],
      assistantOpen: false,
    });
  });

  it("creates a project from one prompt and navigates to autopilot", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={["/projects/new"]}>
        <Routes>
          <Route path="/projects/new" element={<NewProject />} />
          <Route path="/projects/:projectId/auto" element={<div>AUTO DESTINATION</div>} />
        </Routes>
      </MemoryRouter>,
    );

    await user.type(
      screen.getByLabelText(/视频主题或生成要求/),
      "45 秒横屏：为什么夜空是黑色的？",
    );
    await user.click(screen.getByRole("button", { name: "一键生成视频" }));

    expect(await screen.findByText("AUTO DESTINATION")).toBeVisible();
    await waitFor(() => {
      expect(useStudioStore.getState().projects).toHaveLength(1);
    });
    expect(useStudioStore.getState().projects[0]).toMatchObject({
      title: "为什么夜空是黑色的",
      settings: {
        topic: "45 秒横屏：为什么夜空是黑色的？",
        contentType: "科学原理",
        aspectRatio: "16:9",
      },
    });
    expect(useStudioStore.getState().toasts[0]?.title).toBe(
      "项目已创建，准备自动成片",
    );
  });

  it("shows validation before creating an underspecified project", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={["/projects/new"]}>
        <Routes>
          <Route path="/projects/new" element={<NewProject />} />
        </Routes>
      </MemoryRouter>,
    );

    await user.type(screen.getByLabelText(/视频主题或生成要求/), "天");
    await user.click(screen.getByRole("button", { name: "一键生成视频" }));

    expect(
      screen.getByText("输入一个主题，或直接描述你想要的视频。"),
    ).toBeVisible();
    expect(useStudioStore.getState().projects).toHaveLength(0);
  });
});
