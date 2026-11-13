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

  it("creates a project and navigates to planning", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={["/projects/new"]}>
        <Routes>
          <Route path="/projects/new" element={<NewProject />} />
          <Route path="/projects/:projectId/plan" element={<div>PLANNING DESTINATION</div>} />
        </Routes>
      </MemoryRouter>,
    );

    await user.click(screen.getByRole("button", { name: "填充示例" }));
    await user.click(screen.getByRole("button", { name: "创建并进入策划" }));

    expect(await screen.findByText("PLANNING DESTINATION")).toBeVisible();
    await waitFor(() => {
      expect(useStudioStore.getState().projects).toHaveLength(1);
    });
    expect(useStudioStore.getState().projects[0]).toMatchObject({
      title: "夜空为什么是黑色的？",
      settings: {
        topic: "为什么夜空是黑色的？",
        contentType: "科学原理",
        aspectRatio: "16:9",
      },
    });
    expect(useStudioStore.getState().toasts[0]?.title).toBe("项目已创建");
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

    await user.type(screen.getByLabelText(/视频主题/), "天空");
    await user.click(screen.getByRole("button", { name: "创建并进入策划" }));

    expect(screen.getByText("主题再具体一点，至少需要 4 个字符。")).toBeVisible();
    expect(useStudioStore.getState().projects).toHaveLength(0);
  });
});
