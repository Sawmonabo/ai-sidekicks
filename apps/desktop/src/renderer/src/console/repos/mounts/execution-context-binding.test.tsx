// The three-path disclosure against the fixture: the badge, the roots, the absence, and
// where the disclosure stands.
//
// RENDERED THROUGH THE REAL BINDING AND THE REAL GROWTH PORT. The read is a growth-slate
// row with no registered wire method behind it, so its ordinary answer in a shipped
// build is a typed absence — and the case that asserts the served rendering has to come
// from a bridge that actually serves it, which is what the repos fixture does.
//
// THE DENSITY CASES DRIVE THE WORKSPACE'S POSITION AND NOT THE READ. Where the
// disclosure stands is decided by the lifecycle position the row is in, so those cases
// re-render with a new position and never advance the clock — a rule about a transition
// is only pinned by a suite that actually performs one.

import { fireEvent, render, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { WorkspaceState } from "@ai-sidekicks/contracts";

import { createFixtureBridge, type ConsoleBridge } from "../../bridge/index.js";
import { REPOS_SCENARIO } from "../../bridge/scenarios/repos.js";
import {
  ATTACHED_WORKSPACE_ID,
  DRIFTED_WORKSPACE_ID,
  GIT_WORKSPACE_ID,
} from "../../bridge/scenarios/repos-fixture-data.js";
import { ATTACHED_CANONICAL_ROOT } from "../../bridge/scenarios/repos-mutation-replies.js";
import { SessionStore } from "../../store/index.js";
import { advanceScenarioUntil } from "../scenario-clock.test-support.js";
import { ExecutionContextDisclosure } from "./ExecutionContextDisclosure.js";
import {
  BOUND_ROOT_LABEL,
  CHECKOUT_ROOT_LABEL,
  MOUNT_ROOT_LABEL,
} from "./execution-context-model.js";

const MOUNT_ROOT = "/Users/dev/code/ai-sidekicks";

interface DisclosureUnderTest {
  readonly container: HTMLElement;
  /** Move the fixture's frozen clock until the assertion holds. See the support module. */
  readonly advanceUntil: (assert: () => void) => Promise<void>;
  /** Re-render the same mounted row at a new lifecycle position, as a re-read does. */
  readonly setWorkspaceState: (workspaceState: WorkspaceState) => void;
}

function renderDisclosure(
  workspaceId: string,
  mountCanonicalRoot: string = MOUNT_ROOT,
  workspaceState: WorkspaceState = "ready",
): DisclosureUnderTest {
  const bridge: ConsoleBridge = createFixtureBridge({ scenario: REPOS_SCENARIO });
  // Both held outside the element factory: a fresh bridge or store per re-render would
  // re-mint the reader beneath the row, so the re-render would be a remount and the
  // transition cases would be pinning a first mount twice.
  const sessionStore = new SessionStore({ sessionId: REPOS_SCENARIO.sessionId });
  const rowAt = (state: WorkspaceState): React.JSX.Element => (
    <ExecutionContextDisclosure
      bridge={bridge}
      workspaceId={workspaceId}
      mountCanonicalRoot={mountCanonicalRoot}
      workspaceState={state}
      sessionStore={sessionStore}
    />
  );
  const { container, rerender } = render(rowAt(workspaceState));
  return {
    container,
    advanceUntil: (assert) => advanceScenarioUntil(bridge, assert),
    setWorkspaceState: (state) => {
      rerender(rowAt(state));
    },
  };
}

/** The `<details>` the three paths sit behind. */
function pathsDisclosure(container: HTMLElement): HTMLDetailsElement {
  const disclosure = container.querySelector(".meridian-execution-context__paths");
  if (!(disclosure instanceof HTMLDetailsElement)) {
    throw new Error("the row rendered no disclosure for its execution roots");
  }
  return disclosure;
}

/**
 * Close the disclosure the way a participant does — by pressing its summary.
 *
 * The press and not a write to `open`: this disclosure's open state is the component's,
 * so what has to be pinned is that a real toggle reaches it. A test that assigned the
 * property would move the DOM and prove nothing about the control.
 */
function pressSummary(container: HTMLElement): void {
  const summary = pathsDisclosure(container).querySelector("summary");
  if (summary === null) {
    throw new Error("the disclosure rendered no summary to press");
  }
  fireEvent.click(summary);
}

describe("ExecutionContextDisclosure — the three roots", () => {
  it("names all three, with the checkout root among them", async () => {
    // `run_execution_contexts.checkout_root` reaches a person here and nowhere else.
    const disclosure = renderDisclosure(GIT_WORKSPACE_ID);
    await disclosure.advanceUntil(() => {
      expect(within(disclosure.container).getByText(CHECKOUT_ROOT_LABEL)).toBeDefined();
    });
    expect(within(disclosure.container).getByText(MOUNT_ROOT_LABEL)).toBeDefined();
    expect(within(disclosure.container).getByText(BOUND_ROOT_LABEL)).toBeDefined();
  });

  it("says the roots differ in its summary, so the disclosure need not be opened", async () => {
    const disclosure = renderDisclosure(GIT_WORKSPACE_ID);
    await disclosure.advanceUntil(() => {
      expect(within(disclosure.container).getByText("the roots differ")).toBeDefined();
    });
  });

  it("says all three agree where they do, so the disclosure need not be opened for that either", async () => {
    // The attached mount's workspace is bound in the mount's own checkout, and the
    // snapshot service normalizes to the root it was bound at — the one served reading
    // in which the three rows really are one path.
    const disclosure = renderDisclosure(ATTACHED_WORKSPACE_ID, ATTACHED_CANONICAL_ROOT);
    await disclosure.advanceUntil(() => {
      expect(within(disclosure.container).getByText("all three roots agree")).toBeDefined();
    });
  });

  it("claims no agreement where the bound root and the checkout root agree with each other alone", async () => {
    // The `worktree`-mode shape, which is what this disclosure is for: the execution
    // root sits outside the mount it was attached as, and its normalized checkout root
    // is that same root. The summary reads the mount root it was handed, so two roots
    // agreeing is not three.
    const disclosure = renderDisclosure(ATTACHED_WORKSPACE_ID, MOUNT_ROOT);
    await disclosure.advanceUntil(() => {
      expect(within(disclosure.container).getByText("the roots differ")).toBeDefined();
    });
  });
});

describe("ExecutionContextDisclosure — the fallback badge", () => {
  it("marks a substituted execution mode, outside the disclosure", async () => {
    // `Spec-010 §Fallback Behavior` requires a substituted mode marked distinctly from
    // the mode that was asked for, and a marker behind a summary is not marked.
    const disclosure = renderDisclosure(GIT_WORKSPACE_ID);
    await disclosure.advanceUntil(() => {
      expect(within(disclosure.container).getByText("fell back from worktree")).toBeDefined();
    });
    const badge = disclosure.container.querySelector(".meridian-execution-context__fallback");
    expect(badge).not.toBeNull();
    expect(badge?.closest("details")).toBeNull();
  });

  it("negative control: a binding running the mode it was asked for wears no badge", async () => {
    // The drifted workspace's read is unscripted, so this case also proves the badge is
    // not drawn from anything but a served fallback marker.
    const disclosure = renderDisclosure(DRIFTED_WORKSPACE_ID);
    await disclosure.advanceUntil(() => {
      expect(disclosure.container.querySelector(".meridian-refusal--inline")).not.toBeNull();
    });
    expect(disclosure.container.querySelector(".meridian-execution-context__fallback")).toBeNull();
  });
});

describe("ExecutionContextDisclosure — expanded by default only while the workspace is stale", () => {
  it("stands open on a stale row, where the roots are the question rather than detail", () => {
    // `Spec-023 §Console Design (Meridian)` fixes this family's density: the three
    // paths collapse behind one disclosure, expanded by default only while the
    // workspace is `stale`. Writable runs are blocked until repair there, and which
    // root stopped answering is the next thing a person goes and looks at.
    const disclosure = renderDisclosure(GIT_WORKSPACE_ID, MOUNT_ROOT, "stale");

    expect(pathsDisclosure(disclosure.container).open).toBe(true);
  });

  it("negative control: a ready row keeps this family's collapsed posture", () => {
    // Without this, a disclosure that simply stood open on every row would pass the
    // case above — which is the density rule inverted rather than met.
    const disclosure = renderDisclosure(GIT_WORKSPACE_ID, MOUNT_ROOT, "ready");

    expect(pathsDisclosure(disclosure.container).open).toBe(false);
  });

  it("opens on the edge into stale, so a row that goes stale under a reader opens too", () => {
    // The rule is about the TRANSITION and not about the mount: a workspace loses its
    // path while its card is on screen at least as often as before one is drawn.
    const disclosure = renderDisclosure(GIT_WORKSPACE_ID, MOUNT_ROOT, "ready");
    expect(pathsDisclosure(disclosure.container).open).toBe(false);

    disclosure.setWorkspaceState("stale");

    expect(pathsDisclosure(disclosure.container).open).toBe(true);
  });

  it("stays closed once a participant has closed it on a stale row", () => {
    // The section re-reads on all four of the reasons `Spec-023 §Rules every console
    // surface obeys` names, so a default re-derived per render would reopen this on
    // every one of them and the control could never be put away.
    const disclosure = renderDisclosure(GIT_WORKSPACE_ID, MOUNT_ROOT, "stale");
    pressSummary(disclosure.container);
    expect(pathsDisclosure(disclosure.container).open).toBe(false);

    // A re-read landing on the same position, which is what most re-reads are.
    disclosure.setWorkspaceState("stale");

    expect(pathsDisclosure(disclosure.container).open).toBe(false);
  });

  it("does not slam shut on the reader when the workspace recovers", () => {
    // Recovery is not an edge this acts on. Collapsing here would shut three paths in
    // the face of the person who opened them to find out why the row went stale, at the
    // moment those paths are most worth re-reading.
    const disclosure = renderDisclosure(GIT_WORKSPACE_ID, MOUNT_ROOT, "stale");
    expect(pathsDisclosure(disclosure.container).open).toBe(true);

    disclosure.setWorkspaceState("ready");

    expect(pathsDisclosure(disclosure.container).open).toBe(true);
  });
});

describe("ExecutionContextDisclosure — the absences it keeps apart", () => {
  it("renders a refused read as one row's refusal rather than the section's", async () => {
    // A workspace this scenario holds no execution context for refuses, and the
    // refusal is rendered inline: the repos surface is not broken, one row is unread.
    const disclosure = renderDisclosure(DRIFTED_WORKSPACE_ID);
    await disclosure.advanceUntil(() => {
      expect(disclosure.container.querySelector(".meridian-refusal--inline")).not.toBeNull();
    });
    expect(disclosure.container.querySelector(".meridian-refusal--card")).toBeNull();
  });
});
