// Asking for a change set against the fixture, from the pane's own absence arm.
//
// THE CHANGE SET IS DRAWN BY A STAND-IN HERE, AND THAT IS THE SEAM'S POINT. This
// directory does not know how a diff is rendered — the pane hands it a closure — so a
// case that mounted the real renderer would be asserting the row model's geometry
// instead of the one thing this surface owns: that a settled create reaches the caller
// with the model it parsed.

import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { createFixtureBridge, type ConsoleBridge } from "../../../bridge/index.js";
import {
  fixtureBridgeWithGrowth,
  growthRefusing,
} from "../../../bridge/fixture/call-plane/bridge.test-support.js";
import { REPOS_SCENARIO } from "../../../bridge/scenarios/repos.js";
import {
  UNSCRIPTED_COMPARISON_REFUSAL_CODE,
  WORKSPACE_FALLBACK_COMPARED_STATES,
} from "../../../bridge/scenarios/repos/repos-diff-replies.js";
import {
  GIT_WORKSPACE_ID,
  REVIEWER_WORKTREE_ID,
  SESSION_ID,
} from "../../../bridge/scenarios/repos/repos-fixture-data.js";
import { SessionStore } from "../../../store/index.js";
import { advanceScenarioUntil } from "../../../bridge/scenario-runtime/scenario-clock.test-support.js";
import type { ConsoleDiffModel } from "../diff-model.js";
import { DiffCreateSurface } from "./DiffCreateSurface.js";
import type { DiffCreateSubject } from "./diff-create-subject.js";

const WORKSPACE_SUBJECT: DiffCreateSubject = { kind: "workspace", workspaceId: GIT_WORKSPACE_ID };

const ABSENCE = {
  title: "No change set has been asked for.",
  detail: "Name two states and this session mints the diff between them.",
};

interface SurfaceUnderTest {
  readonly container: HTMLElement;
  readonly advanceUntil: (assert: () => void) => Promise<void>;
}

function renderSurface(
  subject: DiffCreateSubject = WORKSPACE_SUBJECT,
  bridge: ConsoleBridge = createFixtureBridge({ scenario: REPOS_SCENARIO }),
): SurfaceUnderTest {
  const { container } = render(
    <DiffCreateSurface
      bridge={bridge}
      subject={subject}
      sessionStore={new SessionStore({ sessionId: REPOS_SCENARIO.sessionId })}
      absence={ABSENCE}
      renderChangeSet={(diff: ConsoleDiffModel) => (
        // A stand-in for the pane's own renderer: the file paths are what proves the
        // model the caller received is the one the payload parsed into.
        <ul className="probe-change-set">
          {diff.files.map((file) => (
            <li key={file.path}>{file.path}</li>
          ))}
        </ul>
      )}
    />,
  );
  return { container, advanceUntil: (assert) => advanceScenarioUntil(bridge, assert) };
}

/** Type into one of the two ref fields, by the legend a person reads. */
function nameState(container: HTMLElement, legend: string, value: string): void {
  const field = [...container.querySelectorAll(".meridian-diff-create__field")].find(
    (candidate) => candidate.textContent?.startsWith(legend) === true,
  );
  const input = field?.querySelector("input");
  if (input === null || input === undefined) {
    throw new Error(`no ${legend} field is on this form`);
  }
  fireEvent.change(input, { target: { value } });
}

function confirm(container: HTMLElement): HTMLButtonElement {
  return container.querySelector(".meridian-diff-create__confirm") as HTMLButtonElement;
}

describe("DiffCreateSurface — before anything has been asked for", () => {
  it("keeps the pane's own absence copy above the form", () => {
    // Still true while a form is open: nothing has been asked.
    const { container } = renderSurface();
    expect(container.textContent).toContain(ABSENCE.title);
    expect(container.querySelector(".meridian-diff-create")).not.toBeNull();
  });

  it("names the arm this create will send, in the wire's own vocabulary", async () => {
    const { container, advanceUntil } = renderSurface();
    await advanceUntil(() => {
      expect(container.querySelector(".meridian-diff-create__attribution")?.textContent).toContain(
        "workspace_fallback",
      );
    });
    expect(container.querySelector(".meridian-diff-create__attribution")?.textContent).toContain(
      GIT_WORKSPACE_ID,
    );
  });

  it("negative control: the control is shut until both states are named, and says why", async () => {
    const { container, advanceUntil } = renderSurface();
    await advanceUntil(() => {
      expect(container.querySelector(".meridian-diff-create__attribution")).not.toBeNull();
    });
    expect(confirm(container).disabled).toBe(true);
    nameState(container, "Base", "origin/develop");
    expect(confirm(container).disabled).toBe(true);
    expect(container.querySelector(".meridian-diff-create__held")?.textContent).toContain(
      "Name both compared states",
    );
  });
});

describe("DiffCreateSurface — a minted change set", () => {
  it("hands the parsed model to the caller's own renderer", async () => {
    const { container, advanceUntil } = renderSurface();
    await advanceUntil(() => {
      expect(container.querySelector(".meridian-diff-create__attribution")).not.toBeNull();
    });
    // The comparison the git workspace actually resolves. The fixture answers a
    // subject for exactly the pair that subject compares, so a case naming any other
    // two refs is asking for the refusal rather than for a change set.
    nameState(container, "Base", WORKSPACE_FALLBACK_COMPARED_STATES.baseRef);
    nameState(container, "Head", WORKSPACE_FALLBACK_COMPARED_STATES.headRef);
    fireEvent.click(confirm(container));
    await advanceUntil(() => {
      expect(container.querySelector(".probe-change-set")).not.toBeNull();
    });
    expect(container.textContent).toContain("scripts/prepare-execution-root.sh");
    // And the way back is beside it, so one comparison is not the end of the pane.
    expect(container.textContent).toContain("Compare two other states");
  });

  it("puts the daemon's own code under the form when a comparison is refused", async () => {
    // The whole route, end to end: the fixture refuses a comparison it does not
    // script, the port wraps that rejection in its own `call-rejected`, and the
    // controller publishes the refusal the DAEMON spoke — so what a person reads and
    // can paste is the daemon's code rather than the name of a seam inside this
    // renderer. The form stays, because a refused comparison is not a lost capability.
    const { container, advanceUntil } = renderSurface();
    await advanceUntil(() => {
      expect(container.querySelector(".meridian-diff-create__attribution")).not.toBeNull();
    });
    nameState(container, "Base", "no-such-base");
    nameState(container, "Head", "no-such-head");
    fireEvent.click(confirm(container));
    await advanceUntil(() => {
      expect(container.querySelector(".meridian-refusal--inline")).not.toBeNull();
    });
    const refusal = container.querySelector(".meridian-refusal--inline")?.textContent ?? "";
    expect(refusal).toContain(UNSCRIPTED_COMPARISON_REFUSAL_CODE);
    expect(refusal).not.toContain("call-rejected");
    expect(container.querySelector(".meridian-diff-create")).not.toBeNull();
  });

  it("negative control: renaming a state drops the refusal it was not about", async () => {
    // The mint is left scripted and the payload read refuses, which is the arm that
    // keeps the form on screen with a settlement on it. Left standing, that refusal
    // would read as a verdict on the pair now in the fields.
    const { container, advanceUntil } = renderSurface(
      WORKSPACE_SUBJECT,
      fixtureBridgeWithGrowth(REPOS_SCENARIO, { artifactRead: growthRefusing("artifactRead") }),
    );
    await advanceUntil(() => {
      expect(container.querySelector(".meridian-diff-create__attribution")).not.toBeNull();
    });
    nameState(container, "Base", WORKSPACE_FALLBACK_COMPARED_STATES.baseRef);
    nameState(container, "Head", WORKSPACE_FALLBACK_COMPARED_STATES.headRef);
    fireEvent.click(confirm(container));
    await advanceUntil(() => {
      expect(container.querySelector(".meridian-refusal--inline")).not.toBeNull();
    });
    nameState(container, "Head", "feat/something-else");
    expect(container.querySelector(".meridian-refusal--inline")).toBeNull();
  });
});

describe("DiffCreateSurface — a refused attribution", () => {
  it("keeps the form, shuts the control, and offers the question again", async () => {
    // The reviewer's root names no run, which is the fixture's prepared-ahead case.
    const { container, advanceUntil } = renderSurface({
      kind: "worktree",
      worktreeId: REVIEWER_WORKTREE_ID,
      sessionId: SESSION_ID,
    });
    await advanceUntil(() => {
      expect(container.textContent).toContain("Ask again");
    });
    expect(container.querySelector(".meridian-diff-create")).not.toBeNull();
    expect(confirm(container).disabled).toBe(true);
  });
});
