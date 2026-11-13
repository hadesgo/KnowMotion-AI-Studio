import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Modal, Progress, Segmented } from "../../src/components/ui";

describe("shared UI components", () => {
  it("updates a controlled segmented control", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <Segmented
        value="scene"
        onChange={onChange}
        label="素材画幅"
        options={[
          { value: "scene", label: "场景" },
          { value: "square", label: "1:1" },
        ]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "1:1" }));
    expect(onChange).toHaveBeenCalledWith("square");
  });

  it("closes the modal with Escape and restores the trigger focus", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const trigger = document.createElement("button");
    trigger.textContent = "open";
    document.body.appendChild(trigger);
    trigger.focus();

    const { unmount } = render(
      <Modal open onClose={onClose} title="测试对话框">
        <button type="button">确认</button>
      </Modal>,
    );
    expect(screen.getByRole("dialog", { name: "测试对话框" })).toBeVisible();
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();

    unmount();
    expect(trigger).toHaveFocus();
    trigger.remove();
  });

  it("clamps progress values for assistive technology", () => {
    const { rerender } = render(<Progress value={-20} />);
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "0");
    rerender(<Progress value={150} />);
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "100");
  });
});
