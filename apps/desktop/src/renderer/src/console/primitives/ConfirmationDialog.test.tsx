// The confirmation dialog: what a disable that arrives while it is open does.
//
// THE CASE THE TRIGGER'S `disabled` DID NOT COVER. The trigger is the only part the
// disable reached, so a shell that closed every write after someone had opened the
// revoke dialog left an enabled confirm inside a modal, over the section sentence
// that explained the refusal. Pressing it reached the dispatch-time guard and did
// nothing, silently.

import { act, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ConfirmationDialog } from "./ConfirmationDialog.js";

function dialog(isDisabled: boolean, onConfirm: () => void = () => undefined): React.JSX.Element {
  return (
    <ConfirmationDialog
      triggerLabel="Revoke"
      triggerAriaLabel="Revoke the membership"
      triggerClassName="planted-trigger"
      isDisabled={isDisabled}
      title="Revoke this membership?"
      description="The membership ends."
      keepLabel="Keep it"
      confirmLabel="Revoke"
      tone="destructive"
      onConfirm={onConfirm}
    />
  );
}

function trigger(root: HTMLElement): HTMLButtonElement {
  const found = root.querySelector<HTMLButtonElement>(".planted-trigger");
  if (found === null) {
    throw new Error("no trigger");
  }
  return found;
}

function popup(root: HTMLElement): Element | null {
  return root.ownerDocument.body.querySelector(".meridian-confirm");
}

describe("ConfirmationDialog — a disable that arrives while it is open", () => {
  it("closes the open dialog, and does not reopen it when the act comes back", () => {
    const { container, rerender } = render(dialog(false));
    act(() => {
      trigger(container).click();
    });
    expect(popup(container)).not.toBeNull();

    rerender(dialog(true));
    expect(popup(container)).toBeNull();
    expect(trigger(container).disabled).toBe(true);

    // The act is available again; the dialog someone opened under the old shell
    // state stays closed, since reopening it would be a modal nobody asked for.
    rerender(dialog(false));
    expect(popup(container)).toBeNull();
    expect(trigger(container).disabled).toBe(false);
  });

  it("negative control: a rerender that keeps the act available keeps the dialog open", () => {
    const { container, rerender } = render(dialog(false));
    act(() => {
      trigger(container).click();
    });
    rerender(dialog(false));
    expect(popup(container)).not.toBeNull();
  });

  it("still confirms and closes through its own confirm", () => {
    const onConfirm = vi.fn();
    const { container } = render(dialog(false, onConfirm));
    act(() => {
      trigger(container).click();
    });
    const confirm = container.ownerDocument.body.querySelector<HTMLButtonElement>(
      ".meridian-confirm__confirm",
    );
    if (confirm === null) {
      throw new Error("no confirm");
    }
    act(() => {
      confirm.click();
    });
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(popup(container)).toBeNull();
  });
});
