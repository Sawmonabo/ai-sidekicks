// The prepare form over a scripted call and the real controller. Controls are reached by class,
// not role: they sit in a collapsed `<details>` that jsdom does not present to the accessibility
// tree as a browser does.

import { fireEvent, render, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { ExecutionMode } from "@ai-sidekicks/contracts/repo/mount";

import { bridgeOnClock } from "#test/helpers/fixture/bridge.js";
import { bridgeWrapper } from "#test/helpers/app/frame-fixtures.js";
import { scriptedRepoOperations } from "#renderer/features/repos/repo-operations.test-support.js";
import { type BindControlAvailability } from "../../health.js";
import { preparingDaemon } from "../../repo-mounts.test-support.js";
import { PrepareExecutionRoot } from "./PrepareExecutionRoot.js";

const UNHELD_BRANCH = "feat/fresh-root";

const CONTROLS_LIVE: BindControlAvailability = { available: true };

interface FormUnderTest {
  readonly container: HTMLElement;
  readonly setExecutionMode: (executionMode: ExecutionMode) => void;
}

function renderForm(): FormUnderTest {
  const { bridge, clock } = bridgeOnClock("repos");
  // Held outside the element factory: a fresh bridge or call set per re-render would re-mint
  // everything beneath the row, pinning two first mounts rather than one re-bind.
  const operations = scriptedRepoOperations(preparingDaemon());
  const formAt = (mode: ExecutionMode): React.JSX.Element => (
    <PrepareExecutionRoot
      bridge={bridge}
      operations={operations}
      workspaceId="workspace-sidekicks"
      executionMode={mode}
      availability={CONTROLS_LIVE}
      onPrepared={() => undefined}
    />
  );
  const { container, rerender } = render(formAt("provisioned-worktree"), {
    wrapper: bridgeWrapper(bridge, clock),
  });
  return {
    container,
    setExecutionMode: (mode) => {
      rerender(formAt(mode));
    },
  };
}

function branchInput(container: HTMLElement): HTMLInputElement {
  const input = within(container).queryByLabelText("Branch");
  if (!(input instanceof HTMLInputElement)) {
    throw new Error("the prepare form rendered no branch field");
  }
  return input;
}

function confirmButton(container: HTMLElement): HTMLButtonElement {
  const button = within(container).queryByRole("button", { name: "Prepare", hidden: true });
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error("the prepare form rendered no confirm control");
  }
  return button;
}

function blockedLine(container: HTMLElement): string | undefined {
  return container.querySelector(".meridian-form__blocked")?.textContent ?? undefined;
}

function nameBranch(container: HTMLElement, branchName: string): void {
  fireEvent.change(branchInput(container), { target: { value: branchName } });
}

describe("PrepareExecutionRoot — the form's lifetime", () => {
  it("empties the form when the mode-scoped controller behind it is re-minted", () => {
    // The row is keyed by workspace id, so React never unmounts it across a re-bind in another
    // mode while the controller underneath is re-minted; a surviving branch would sit above a
    // controller that was never told it.
    const { container, setExecutionMode } = renderForm();
    nameBranch(container, UNHELD_BRANCH);
    expect(confirmButton(container).disabled).toBe(false);

    setExecutionMode("bound-root");
    setExecutionMode("provisioned-worktree");

    expect(branchInput(container).value).toBe("");
    expect(confirmButton(container).disabled).toBe(true);
    expect(blockedLine(container)).toContain("Name the branch");
  });
});
