import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";
import { createCharacter, makeSampleProject } from "../../src/data/demo";
import Canon from "../../src/pages/Canon";
import { useStudioStore } from "../../src/store/studio";

function renderCanon(projectId: string) {
  return render(
    <MemoryRouter initialEntries={[`/projects/${projectId}/canon`]}>
      <Routes>
        <Route path="/projects/:projectId/canon" element={<Canon />} />
        <Route path="/projects/:projectId/assets" element={<div>ASSETS</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("Canon setting workspace", () => {
  beforeEach(() => {
    const state = useStudioStore.getState();
    const project = makeSampleProject();
    const character = createCharacter("林博士", "解说者");
    character.appearance = "短卷发，圆框眼镜，深色高领毛衣";
    character.wardrobe = "米白色实验服";
    project.characters = [character];
    project.scenes[0] = {
      ...project.scenes[0],
      characterIds: [character.id],
    };
    useStudioStore.setState({
      projects: [project],
      providers: state.providers,
      taskRoutes: state.taskRoutes,
      toasts: [],
      assistantOpen: false,
    });
  });

  it("renders coverage, character anchors and per-shot status", async () => {
    const project = useStudioStore.getState().projects[0];
    renderCanon(project.id);

    expect(await screen.findByText("角色 · 1")).toBeVisible();
    expect(screen.getAllByText("林博士").length).toBeGreaterThan(0);
    expect(screen.getByText("CONSISTENCY COVERAGE")).toBeVisible();
    expect(screen.getByRole("progressbar")).toBeVisible();
    expect(screen.getAllByText("未绑定").length).toBe(4);
  });

  it("creates a character card and stores it in the project", async () => {
    const user = userEvent.setup();
    const project = useStudioStore.getState().projects[0];
    renderCanon(project.id);

    await user.click(screen.getByRole("button", { name: "新增角色" }));

    const characters = useStudioStore.getState().projects[0].characters;
    expect(characters).toHaveLength(2);
    expect(characters[1].name).toBe("角色 2");
    expect((await screen.findAllByText("角色 2")).length).toBeGreaterThan(0);
  });

  it("adds a generated reference draft to the selected character", async () => {
    const user = userEvent.setup();
    const project = useStudioStore.getState().projects[0];
    const characterId = project.characters[0].id;
    renderCanon(project.id);

    await user.click(
      screen.getAllByRole("button", { name: "生成参考草案" })[0],
    );

    const updated = useStudioStore.getState().projects[0];
    const reference = updated.assets.find(
      (asset) => asset.reference?.role === "character",
    );
    expect(reference).toBeDefined();
    expect(reference?.reference?.entityId).toBe(characterId);
    expect(
      updated.characters[0].referenceAssetIds,
    ).toContain(reference?.id);
    expect(useStudioStore.getState().toasts.at(-1)?.title).toBe(
      "已生成可编辑的参考草案",
    );
  });
});
