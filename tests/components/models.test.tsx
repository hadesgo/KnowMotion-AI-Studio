import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import Models from "../../src/pages/Models";
import { useStudioStore } from "../../src/store/studio";

describe("Models provider configuration", () => {
  beforeEach(() => {
    useStudioStore.setState({
      providers: [],
      taskRoutes: {},
      toasts: [],
    });
  });

  it("adds a ModelScope async image provider preset", async () => {
    const user = userEvent.setup();
    render(<Models />);

    await user.click(screen.getByRole("button", { name: "添加 Provider" }));
    const dialog = screen.getByRole("dialog");
    expect(dialog).toBeVisible();
    await user.type(within(dialog).getByLabelText("显示名称"), "ModelScope Image");
    const selects = within(dialog).getAllByRole("combobox");
    await user.selectOptions(selects[1], "ModelScope");

    expect(
      within(dialog).getByDisplayValue("https://api-inference.modelscope.cn"),
    ).toHaveValue(
      "https://api-inference.modelscope.cn",
    );
    expect(
      within(dialog).getByDisplayValue("Qwen/Qwen-Image-2.1-Turbo"),
    ).toHaveValue(
      "Qwen/Qwen-Image-2.1-Turbo",
    );

    await user.click(
      within(dialog).getByRole("button", { name: "保存 Provider" }),
    );

    await waitFor(() =>
      expect(useStudioStore.getState().providers).toHaveLength(1),
    );
    expect(useStudioStore.getState().providers[0]).toMatchObject({
      name: "ModelScope Image",
      protocol: "ModelScope",
      baseUrl: "https://api-inference.modelscope.cn",
      model: "Qwen/Qwen-Image-2.1-Turbo",
      capabilities: ["Image"],
      enabled: true,
    });
  });

  it("adds a Fish Audio TTS provider preset", async () => {
    const user = userEvent.setup();
    render(<Models />);

    await user.click(screen.getByRole("button", { name: "添加 Provider" }));
    const dialog = screen.getByRole("dialog");
    await user.type(within(dialog).getByLabelText("显示名称"), "Fish Voice");
    const selects = within(dialog).getAllByRole("combobox");
    await user.selectOptions(selects[1], "Fish Audio");

    expect(
      within(dialog).getByDisplayValue("https://api.fish.audio"),
    ).toHaveValue("https://api.fish.audio");
    expect(
      within(dialog).getByDisplayValue("s2.1-pro-free"),
    ).toHaveValue("s2.1-pro-free");

    await user.click(
      within(dialog).getByRole("button", { name: "保存 Provider" }),
    );

    await waitFor(() =>
      expect(useStudioStore.getState().providers).toHaveLength(1),
    );
    expect(useStudioStore.getState().providers[0]).toMatchObject({
      name: "Fish Voice",
      protocol: "Fish Audio",
      baseUrl: "https://api.fish.audio",
      model: "s2.1-pro-free",
      capabilities: ["TTS"],
      enabled: true,
    });
  });
});
