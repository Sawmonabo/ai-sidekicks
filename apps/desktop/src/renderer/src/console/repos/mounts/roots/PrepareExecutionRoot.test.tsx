// The prepare form against the fixture: what it sends, and the three states it will not.
//
// EVERY CASE DRIVES THE REAL CONTROLLER. The guard this suite is about is a guard about
// TIMING — the window between a branch being typed and the reuse check answering for it —
// so a case that handed the component a pre-settled reading would be asserting the one
// state the defect is not in. The fixture's frozen clock is what makes that window
// enterable: nothing settles until the case advances it.
//
// AND THE CONTROLS ARE REACHED BY CLASS RATHER THAN BY ROLE. They live inside a
// collapsed `<details>`, whose contents jsdom does not present to the accessibility tree
// the way a browser does, so a role query would be asserting the disclosure's posture
// instead of the form's.

import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { WORKTREE_GIT_REF_MAX_LEN, type ExecutionMode } from "@ai-sidekicks/contracts";

import { createFixtureBridge, type ConsoleBridge } from "../../../bridge/index.js";
import { REPOS_SCENARIO } from "../../../bridge/scenario/repos/repos.js";
import {
  GIT_MOUNT_ID,
  GIT_WORKSPACE_ID,
} from "../../../bridge/scenario/repos/repos-fixture-data.js";
import { SessionStore } from "../../../store/index.js";
import { advanceScenarioUntil } from "../../../bridge/scenario/runtime/clock.test-support.js";
import { workspaceControlPosture, type WorkspaceControlPosture } from "../mount-health.js";
import { PrepareExecutionRoot } from "./PrepareExecutionRoot.js";
import { REUSE_UNANSWERED_COPY } from "./root-act-model.js";
import { quietShell } from "../../../store/shell-condition.test-support.js";

/** The fixture branch with a live, dirty, compatible candidate — the consent case. */
const DIRTY_CANDIDATE_BRANCH = "feat/rate-limit-wiring";

/** A fixture branch with no candidate at all, which prepares without a consent. */
const UNHELD_BRANCH = "feat/fresh-root";

/** The card hands the form a live posture; the held arm is `ExecutionModePicker.test.tsx`'s. */
const CONTROLS_LIVE: WorkspaceControlPosture = workspaceControlPosture(
  { offered: true },
  undefined,
);

interface FormUnderTest {
  readonly container: HTMLElement;
  /** Move the fixture's frozen clock until the assertion holds. */
  readonly advanceUntil: (assert: () => void) => Promise<void>;
  /** Re-render the same mounted row in another execution mode, as a mode switch does. */
  readonly setExecutionMode: (executionMode: ExecutionMode) => void;
}

function renderForm(executionMode: ExecutionMode = "worktree"): FormUnderTest {
  const bridge: ConsoleBridge = createFixtureBridge({ scenario: REPOS_SCENARIO });
  // Held outside the element factory for `execution-context-binding.test.tsx`'s reason: a
  // fresh bridge or store per re-render would re-mint everything beneath the row, so the
  // mode-switch case would be pinning two first mounts rather than one switch.
  const sessionStore = new SessionStore({ sessionId: REPOS_SCENARIO.sessionId });
  const formAt = (mode: ExecutionMode): React.JSX.Element => (
    <PrepareExecutionRoot
      bridge={bridge}
      workspaceId={GIT_WORKSPACE_ID}
      repoMountId={GIT_MOUNT_ID}
      executionMode={mode}
      sessionStore={sessionStore}
      posture={CONTROLS_LIVE}
      frameStore={quietShell()}
      onPrepared={() => undefined}
    />
  );
  const { container, rerender } = render(formAt(executionMode));
  return {
    container,
    advanceUntil: (assert) => advanceScenarioUntil(bridge, assert),
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

/** The sentence under a closed control, or `undefined` where the control is open. */
function blockedLine(container: HTMLElement): string | undefined {
  return container.querySelector(".meridian-prepare-root__blocked")?.textContent ?? undefined;
}

/** The dirty-candidate consent, which exists only while that verdict is on screen. */
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
    // The window the defect lived in: the check is in flight, the old form read that as
    // no candidate, and a prepare sent here omits `reuseWorktreeId` for a branch that may
    // have one — an implicit collision the daemon refuses.
    expect(confirmButton(container).disabled).toBe(true);
    expect(blockedLine(container)).toBe(REUSE_UNANSWERED_COPY);

    await advanceUntil(() => {
      expect(confirmButton(container).disabled).toBe(false);
    });
    expect(blockedLine(container)).toBeUndefined();
  });

  it("negative control: a clone asks no reuse question and is not held by one", () => {
    // Its reading sits at `not-read` for the life of the surface, so a guard that read
    // that as a question in flight would close this control permanently.
    const { container } = renderForm("ephemeral clone");
    nameBranch(container, UNHELD_BRANCH);
    expect(confirmButton(container).disabled).toBe(false);
  });

  it("holds a branch name past the contract's own bound, and says by how much", () => {
    const { container } = renderForm();
    nameBranch(container, "b".repeat(WORKTREE_GIT_REF_MAX_LEN + 1));
    expect(confirmButton(container).disabled).toBe(true);
    expect(blockedLine(container)).toContain(String(WORKTREE_GIT_REF_MAX_LEN + 1));
  });
});

describe("PrepareExecutionRoot — the dirty-candidate consent", () => {
  it("draws the consent unticked and opens the control only once it is given", async () => {
    const { container, advanceUntil } = renderForm();
    nameBranch(container, DIRTY_CANDIDATE_BRANCH);
    await advanceUntil(() => {
      expect(consentBox(container)).toBeDefined();
    });

    const box = consentBox(container);
    expect(box?.checked).toBe(false);
    expect(confirmButton(container).disabled).toBe(true);

    fireEvent.click(box as HTMLInputElement);
    // The box records the candidate's own id, and both the tick and the control read it
    // back through the same predicate the act sends on.
    expect(consentBox(container)?.checked).toBe(true);
    expect(confirmButton(container).disabled).toBe(false);
  });

  it("negative control: editing the branch withdraws the consent and the control with it", async () => {
    const { container, advanceUntil } = renderForm();
    nameBranch(container, DIRTY_CANDIDATE_BRANCH);
    await advanceUntil(() => {
      expect(consentBox(container)).toBeDefined();
    });
    fireEvent.click(consentBox(container) as HTMLInputElement);
    expect(confirmButton(container).disabled).toBe(false);

    nameBranch(container, `${DIRTY_CANDIDATE_BRANCH}-2`);
    expect(confirmButton(container).disabled).toBe(true);
  });
});

describe("PrepareExecutionRoot — the form's lifetime", () => {
  it("empties the form when the mode-scoped controller behind it is re-minted", async () => {
    // The row is keyed by workspace id, so React never unmounts this component across a
    // mode switch. The controller underneath it IS re-minted, and a form that survived
    // that would sit above a controller which has asked nothing about the branch it
    // holds — offering a prepare against a verdict nobody read.
    const { container, advanceUntil, setExecutionMode } = renderForm();
    nameBranch(container, UNHELD_BRANCH);
    await advanceUntil(() => {
      expect(confirmButton(container).disabled).toBe(false);
    });

    setExecutionMode("ephemeral clone");
    setExecutionMode("worktree");

    expect(branchInput(container).value).toBe("");
    expect(confirmButton(container).disabled).toBe(true);
    expect(blockedLine(container)).toContain("Name the branch");
  });

  it("negative control: a re-render in the same mode keeps what was typed", async () => {
    const { container, advanceUntil, setExecutionMode } = renderForm();
    nameBranch(container, UNHELD_BRANCH);
    await advanceUntil(() => {
      expect(confirmButton(container).disabled).toBe(false);
    });

    setExecutionMode("worktree");

    expect(branchInput(container).value).toBe(UNHELD_BRANCH);
    expect(confirmButton(container).disabled).toBe(false);
  });
});
