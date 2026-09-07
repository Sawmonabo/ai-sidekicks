// The three-path disclosure against the fixture: the badge, the roots, and the absence.
//
// RENDERED THROUGH THE REAL BINDING AND THE REAL GROWTH PORT. The read is a growth-slate
// row with no registered wire method behind it, so its ordinary answer in a shipped
// build is a typed absence — and the case that asserts the served rendering has to come
// from a bridge that actually serves it, which is what the repos fixture does.

import { render, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

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
}

function renderDisclosure(
  workspaceId: string,
  mountCanonicalRoot: string = MOUNT_ROOT,
): DisclosureUnderTest {
  const bridge: ConsoleBridge = createFixtureBridge({ scenario: REPOS_SCENARIO });
  const { container } = render(
    <ExecutionContextDisclosure
      bridge={bridge}
      workspaceId={workspaceId}
      mountCanonicalRoot={mountCanonicalRoot}
      sessionStore={new SessionStore({ sessionId: REPOS_SCENARIO.sessionId })}
    />,
  );
  return {
    container,
    advanceUntil: (assert) => advanceScenarioUntil(bridge, assert),
  };
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
