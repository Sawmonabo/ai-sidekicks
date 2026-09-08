// The row's Manage menu: what a close that arrives while it is open does.
//
// THE CASE THE TRIGGER'S `disabled` DID NOT COVER. The trigger is the only part a close
// reached, so a shell that stopped serving after someone had opened the menu left its
// role and lifecycle items pressable over the section sentence that explained the
// refusal. Pressing one reached the dispatch-time guard and did nothing, silently.

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ShellMutationBlock } from "../../store/index.js";

import { membershipRow } from "./members-model.test-support.js";
import { MembershipActionsMenu } from "./MembershipActionsMenu.js";

afterEach(cleanup);

/** The block a stopped supervisor puts on every membership act. */
const STOPPED: ShellMutationBlock = {
  code: "stopped",
  detail: "The runtime is not serving, so memberships cannot change.",
};

/** The menu over an active collaborator, so every role and lifecycle item is offered. */
function menu(
  updateBlock: ShellMutationBlock | undefined,
  onApply: (update: unknown) => void = () => undefined,
): React.JSX.Element {
  return (
    <MembershipActionsMenu
      row={membershipRow({ role: "collaborator" })}
      isPending={false}
      isAnyPending={false}
      updateBlock={updateBlock}
      onApply={onApply}
    />
  );
}

function trigger(root: HTMLElement): HTMLButtonElement {
  const found = root.querySelector<HTMLButtonElement>(".meridian-members__manage");
  if (found === null) {
    throw new Error("no trigger");
  }
  return found;
}

/** The menu's popup, which the primitive portals into the window's airspace. */
function popup(root: HTMLElement): Element | null {
  return root.ownerDocument.body.querySelector('[role="menu"]');
}

function itemNamed(root: HTMLElement, label: string): HTMLElement {
  const found = [
    ...root.ownerDocument.body.querySelectorAll<HTMLElement>('[role="menuitem"]'),
  ].find((item) => item.textContent === label);
  if (found === undefined) {
    throw new Error(`no menu item reads ${JSON.stringify(label)}`);
  }
  return found;
}

describe("MembershipActionsMenu — a close that arrives while it is open", () => {
  it("closes the open menu, and does not reopen it when the acts come back", () => {
    const { container, rerender } = render(menu(undefined));
    act(() => {
      trigger(container).click();
    });
    expect(popup(container)).not.toBeNull();

    rerender(menu(STOPPED));
    expect(popup(container)).toBeNull();
    expect(trigger(container).disabled).toBe(true);

    rerender(menu(undefined));
    expect(popup(container)).toBeNull();
    expect(trigger(container).disabled).toBe(false);
  });

  it("negative control: a rerender that keeps the acts available keeps the menu open", () => {
    const { container, rerender } = render(menu(undefined));
    act(() => {
      trigger(container).click();
    });
    rerender(menu(undefined));
    expect(popup(container)).not.toBeNull();
  });

  it("still applies an item's act through its own press, and closes on it", () => {
    const onApply = vi.fn();
    const { container } = render(menu(undefined, onApply));
    act(() => {
      trigger(container).click();
    });
    act(() => {
      itemNamed(container, "Make owner").click();
    });
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply).toHaveBeenCalledWith({
      membershipId: "membership-1",
      action: "change_role",
      newRole: "owner",
    });
    expect(popup(container)).toBeNull();
  });
});
