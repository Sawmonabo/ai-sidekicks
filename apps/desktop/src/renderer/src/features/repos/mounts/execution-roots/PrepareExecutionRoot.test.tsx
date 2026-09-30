// The prepare form over scripted calls and the real controller, with a frozen clock so the
// window between typing a branch and the check answering can be entered. Controls are reached
// by class, not role: they sit in a collapsed `<details>` that jsdom does not present to the
// accessibility tree as a browser does.

import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { type ExecutionMode } from "@ai-sidekicks/contracts";

import { advanceScenarioUntil } from "@test/helpers/scenario-manual-clock.js";
import { SessionStore } from "@renderer/store/session/session-store.js";
import { bridgeOnClock } from "@test/helpers/fixture-bridge.js";
import { bridgeWrapper } from "@test/helpers/app-frame-fixtures.js";
import { scriptedRepoOperations } from "../../repo-operations.test-support.js";
import {
  readWorkspaceControlAvailability,
  type WorkspaceControlAvailability,
} from "../mount-health.js";
import { DIRTY_BRANCH, preparingDaemon } from "../repo-mounts.test-support.js";
import { PrepareExecutionRoot } from "./PrepareExecutionRoot.js";
import { REUSE_UNANSWERED_COPY } from "./prepare-form.js";

const UNHELD_BRANCH = "feat/fresh-root";

const CONTROLS_LIVE: WorkspaceControlAvailability = readWorkspaceControlAvailability(
  { offered: true },
  undefined,
);

interface FormUnderTest {
  readonly container: HTMLElement;
  readonly advanceUntil: (assert: () => void) => Promise<void>;
  readonly setExecutionMode: (executionMode: ExecutionMode) => void;
}

function renderForm(): FormUnderTest {
  const { bridge, scenarioEngine, clock } = bridgeOnClock("repos");
  // Held outside the element factory: a fresh bridge, store or call set per re-render would
  // re-mint everything beneath the row, pinning two first mounts rather than one switch.
  const sessionStore = new SessionStore({ sessionId: "session-repos" });
  const operations = scriptedRepoOperations(preparingDaemon());
  const formAt = (mode: ExecutionMode): React.JSX.Element => (
    <PrepareExecutionRoot
      bridge={bridge}
      operations={operations}
      workspaceId="workspace-sidekicks"
      repoMountId="mount-sidekicks"
      executionMode={mode}
      sessionStore={sessionStore}
      posture={CONTROLS_LIVE}
      onPrepared={() => undefined}
    />
  );
  const { container, rerender } = render(formAt("provisioned-worktree"), {
    wrapper: bridgeWrapper(bridge, clock),
  });
  return {
    container,
    advanceUntil: async (assert) => {
      await advanceScenarioUntil(scenarioEngine, assert);
    },
    setExecutionMode: (mode) => {
      rerender(formAt(mode));
    },
  };
}

function branchInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector(".meridian-prepare-root__branch-input");
  if (!(input instanceof HTMLInputElement)) {
    throw new Error("the prepare form rendered no branch field");
  }
  return input;
}

function confirmButton(container: HTMLElement): HTMLButtonElement {
  const button = container.querySelector(".meridian-prepare-root__confirm");
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error("the prepare form rendered no confirm control");
  }
  return button;
}

function blockedLine(container: HTMLElement): string | undefined {
  return container.querySelector(".meridian-prepare-root__blocked")?.textContent ?? undefined;
}

function consentBox(container: HTMLElement): HTMLInputElement | undefined {
  const box = container.querySelector(".meridian-prepare-root__consent input");
  return box instanceof HTMLInputElement ? box : undefined;
}

function nameBranch(container: HTMLElement, branchName: string): void {
  fireEvent.change(branchInput(container), { target: { value: branchName } });
}

describe("PrepareExecutionRoot — the reuse check holds the control", () => {
  it("will not send a prepare before the check for that branch has answered", async () => {
    const { container, advanceUntil } = renderForm();
    nameBranch(container, UNHELD_BRANCH);
    // The check is in flight: a prepare sent here would omit `reuseWorktreeId` for a branch
    // that may have one, an implicit collision the daemon refuses.
    expect(confirmButton(container).disabled).toBe(true);
    expect(blockedLine(container)).toBe(REUSE_UNANSWERED_COPY);

    await advanceUntil(() => {
      expect(confirmButton(container).disabled).toBe(false);
    });
    expect(blockedLine(container)).toBeUndefined();
  });
});

describe("PrepareExecutionRoot — the dirty-candidate consent", () => {
  it("draws the consent unticked and opens the control only once it is given", async () => {
    const { container, advanceUntil } = renderForm();
    nameBranch(container, DIRTY_BRANCH);
    await advanceUntil(() => {
      expect(consentBox(container)).toBeDefined();
    });

    const box = consentBox(container);
    expect(box?.checked).toBe(false);
    expect(confirmButton(container).disabled).toBe(true);

    fireEvent.click(box as HTMLInputElement);
    // The box records the candidate's own id; the tick and the control read it back the same way.
    expect(consentBox(container)?.checked).toBe(true);
    expect(confirmButton(container).disabled).toBe(false);
  });

  it("shuts the control on a branch edit, though the consent was given", async () => {
    const { container, advanceUntil } = renderForm();
    nameBranch(container, DIRTY_BRANCH);
    await advanceUntil(() => {
      expect(consentBox(container)).toBeDefined();
    });
    fireEvent.click(consentBox(container) as HTMLInputElement);
    expect(confirmButton(container).disabled).toBe(false);

    nameBranch(container, `${DIRTY_BRANCH}-2`);
    expect(confirmButton(container).disabled).toBe(true);
  });
});

describe("PrepareExecutionRoot — the form's lifetime", () => {
  it("empties the form when the mode-scoped controller behind it is re-minted", async () => {
    // The row is keyed by workspace id, so React never unmounts it across a mode switch while
    // the controller underneath is re-minted; a surviving form would sit above a controller
    // that has asked nothing about its branch.
    const { container, advanceUntil, setExecutionMode } = renderForm();
    nameBranch(container, UNHELD_BRANCH);
    await advanceUntil(() => {
      expect(confirmButton(container).disabled).toBe(false);
    });

    setExecutionMode("bound-root");
    setExecutionMode("provisioned-worktree");

    expect(branchInput(container).value).toBe("");
    expect(confirmButton(container).disabled).toBe(true);
    expect(blockedLine(container)).toContain("Name the branch");
  });
});
