// A clone root and the gate under it — and the one absence this row can hit.
//
// The row's whole reason to exist is that its absence differs from the worktree row's:
// a clone NAMES its workspace, so nothing is being inferred, and the only thing that
// can be missing is the roster entry for the workspace the clone already named. Both
// cases below are about that difference rather than about the markup.

import { render, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  fixtureBridgeWithGrowth,
  growthServing,
} from "../../bridge/fixture/fixture-bridge.test-support.js";
import { REPOS_SCENARIO } from "../../bridge/scenarios/repos.js";
import { LiveAnnouncerProvider } from "../../primitives/index.js";
import { ManualClock } from "../../core/index.js";
import { SessionStore } from "../../store/index.js";
import { EphemeralCloneGateRow } from "./EphemeralCloneGateRow.js";
import {
  CLONE_WORKSPACE_UNNAMED_COPY,
  EPHEMERAL_CLONE_UNADDRESSABLE_COPY,
  ephemeralCloneGateSubject,
} from "./proposal-gate-model.js";
import type { EphemeralCloneStatusRecord } from "../mounts/worktree-model.js";
import { cloneRecord } from "../mounts/repo-mounts.test-support.js";

const NOW = Date.UTC(2026, 0, 1, 9, 30, 0);

const CLONE: EphemeralCloneStatusRecord = cloneRecord();

/**
 * A bridge that would serve a context if anything asked it for one.
 *
 * Deliberately generous: a row that reached the wire at all would get a reading back,
 * so a case asserting the designed absence is asserting that no call was made rather
 * than that the call failed.
 */
const SERVING_BRIDGE = fixtureBridgeWithGrowth(REPOS_SCENARIO, {
  gitflowBranchContextRead: growthServing({
    // Flat, exactly as `BranchContextReadResponse` returns it: the context's fields
    // ARE the reply, and there is no envelope member to reach through.
    branchContextId: "019b7b30-0280-7c11-8420-b1a5c0de2301",
    workspaceId: CLONE.workspaceId,
    baseBranch: "develop",
    headBranch: CLONE.branchName,
  }),
});

function renderRow(
  workspaces: readonly {
    readonly id: string;
    readonly repoMountId: string;
    readonly executionMode: "ephemeral clone";
  }[],
): HTMLElement {
  const { container } = render(
    <LiveAnnouncerProvider clock={new ManualClock()}>
      <EphemeralCloneGateRow
        record={CLONE}
        subject={ephemeralCloneGateSubject(CLONE, workspaces)}
        bridge={SERVING_BRIDGE}
        sessionStore={new SessionStore({ sessionId: "session-repos" })}
        nowMilliseconds={NOW}
        onRequestRead={() => undefined}
      />
    </LiveAnnouncerProvider>,
  );
  return container;
}

const ROSTER = [
  {
    id: CLONE.workspaceId,
    repoMountId: "019b7b30-0280-7c11-8420-b1a5c0de2003",
    executionMode: "ephemeral clone",
  },
] as const;

describe("EphemeralCloneGateRow", () => {
  it("draws the clone and a gate that says which key the read has none of", () => {
    const container = renderRow(ROSTER);
    // The card is still there — a root that exists is reported whether or not a gate
    // can be asked about it.
    expect(within(container).getByRole("heading", { level: 4 }).textContent).toBe(CLONE.branchName);
    const gate = container.querySelector("details.meridian-root-gate");
    expect(gate).not.toBeNull();
    // Scoped to the gate rather than to the row: the same sentence is also ANNOUNCED,
    // and the announcer's live region renders it too — a document-wide query would
    // match the announcement and prove nothing about what is on the gate.
    expect(within(gate as HTMLElement).getByText(EPHEMERAL_CLONE_UNADDRESSABLE_COPY)).toBeDefined();
  });

  it("builds no gate at all where the roster names no such workspace", () => {
    // No reader, so no call: the mode a gate would report against lives on the roster
    // row and nowhere else, and choosing one here would be a guess drawn as a reading.
    const container = renderRow([
      {
        id: "workspace-other",
        repoMountId: "019b7b30-0280-7c11-8420-b1a5c0de2003",
        executionMode: "ephemeral clone",
      },
    ]);
    expect(container.querySelector("details.meridian-root-gate")).toBeNull();
    expect(within(container).getByText(CLONE_WORKSPACE_UNNAMED_COPY)).toBeDefined();
  });

  it("negative control: the two absences are different sentences", () => {
    // Without this, both cases above would pass against a row that printed one
    // catch-all sentence for "no gate here" — which would tell a participant nothing
    // about whether the roster is incomplete or the wire has no key for this root.
    expect(CLONE_WORKSPACE_UNNAMED_COPY).not.toBe(EPHEMERAL_CLONE_UNADDRESSABLE_COPY);
    const paired = renderRow(ROSTER);
    expect(within(paired).queryByText(CLONE_WORKSPACE_UNNAMED_COPY)).toBeNull();
  });
});
