// One mode switch per workspace on the wire, and what a second press gets instead.
//
// DRIVEN THROUGH `RepoMountsReader.requestModeSelection`, which is the one seam a
// surface has: the selections are constructed by the reader and handed its host, so a
// case that built an `ExecutionModeSelections` over a hand-written host would be
// asserting against a host the console never composes.
//
// THE BRIDGE IS THE REAL FIXTURE WITH ONE CALL HELD OPEN, through the bridge family's
// own `withDaemonCall`. Every read a case makes is the scenario's own — the pass-through
// that helper hands the answer is what delegates them — and only
// `repo.executionModeSelect` is gated, because the whole subject here is what happens
// BETWEEN a press and its answer, a window a scripted reply that settles immediately has
// no way to open. Spreading the daemon namespace here instead would be this suite
// reaching the call door, which the chokepoint gate forbids for exactly the reason it
// forbids it in a surface.

import type { ExecutionMode, WorkspaceId } from "@ai-sidekicks/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { createFixtureBridge, type ConsoleBridge } from "../../bridge/index.js";
import { withDaemonCall } from "../../bridge/fixture-bridge.test-support.js";
import { REPOS_SCENARIO } from "../../bridge/scenarios/repos.js";
import { GIT_WORKSPACE_ID, PLAIN_WORKSPACE_ID } from "../../bridge/scenarios/repos-fixture-data.js";
import { ManualClock, REFRESH_DEBOUNCE_MS } from "../../core/index.js";
import { SessionStore } from "../../store/index.js";
import { RepoMountsReader } from "./repo-mounts-reader.js";
import { selectionInFlightCopy } from "./execution-mode-selection.js";

/** The one call a mode switch makes, held open so a case can press again mid-flight. */
const MODE_SELECT_CALL = "repo.executionModeSelect";

/** The fixture bridge with its mode-select call parked, and the two handles for it. */
interface HeldModeSelect {
  readonly bridge: ConsoleBridge;
  /** How many selects actually reached the wire — the "no second call" assertion. */
  readonly selectCallCount: () => number;
  /** Let every parked select through, in the order they were made. */
  readonly release: () => void;
}

/** The daemon's answer to a released select: the scenario's own, or a rejection. */
type ReleasedSelect = "served" | "rejected";

/**
 * What each released select answers, in call order.
 *
 * A LIST AND NOT ONE VALUE, because the retry cases turn on the answer CHANGING: a
 * refusal followed by a second press that is served is the sequence a stale refusal
 * survives, and a port that answered every call the same way could not produce it.
 * The last entry repeats, so a case naming one answer still names it once.
 */
type ReleasedSelects = ReleasedSelect | readonly ReleasedSelect[];

function bridgeHoldingModeSelect(released: ReleasedSelects = "served"): HeldModeSelect {
  const parked: (() => void)[] = [];
  let calls = 0;
  const answerFor = (callNumber: number): ReleasedSelect =>
    typeof released === "string"
      ? released
      : (released[Math.min(callNumber - 1, released.length - 1)] ?? "served");
  const held = withDaemonCall(
    createFixtureBridge({ scenario: REPOS_SCENARIO }),
    async (call, passThrough) => {
      if (call.method !== MODE_SELECT_CALL) {
        return await passThrough();
      }
      calls += 1;
      const answer = answerFor(calls);
      await new Promise<void>((letThrough) => parked.push(letThrough));
      if (answer === "rejected") {
        // A typed daemon refusal, in the envelope shape the wire sends. The refusal
        // path is what a settle-after-unmount would WRITE, which is why the case that
        // asserts it writes nothing has to take this arm.
        throw { code: "workspace.busy", message: "This workspace is provisioning." };
      }
      return await passThrough();
    },
  );
  return {
    bridge: held.bridge,
    selectCallCount: () => calls,
    release: () => {
      for (const letThrough of parked.splice(0)) {
        letThrough();
      }
    },
  };
}

const readers: RepoMountsReader[] = [];

afterEach(() => {
  while (readers.length > 0) {
    readers.pop()?.dispose();
  }
});

/** Drive the frozen clock past the debounce and let the read's promises settle. */
async function settle(clock: ManualClock, reader: RepoMountsReader): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) {
    await Promise.resolve();
  }
  clock.advance(REFRESH_DEBOUNCE_MS);
  for (let turn = 0; turn < 50 && reader.snapshot.status !== "read"; turn += 1) {
    await Promise.resolve();
  }
}

/** Let the queued continuations of a settled act run, without moving the clock. */
async function drain(): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) {
    await Promise.resolve();
  }
}

/** A section that has read, with its mode-select call parked. */
async function openWithHeldSelect(released: ReleasedSelects = "served"): Promise<{
  reader: RepoMountsReader;
  clock: ManualClock;
  port: HeldModeSelect;
}> {
  const clock = new ManualClock();
  const port = bridgeHoldingModeSelect(released);
  const reader = new RepoMountsReader({
    bridge: port.bridge,
    sessionStore: new SessionStore({ sessionId: REPOS_SCENARIO.sessionId }),
    clock,
  });
  readers.push(reader);
  reader.start();
  await settle(clock, reader);
  return { reader, clock, port };
}

const GIT_WORKSPACE = GIT_WORKSPACE_ID as WorkspaceId;
const PLAIN_WORKSPACE = PLAIN_WORKSPACE_ID as WorkspaceId;
const WORKTREE_MODE = "worktree" satisfies ExecutionMode;
const BRANCH_MODE = "branch" satisfies ExecutionMode;

describe("ExecutionModeSelections — one switch per workspace at a time", () => {
  it("names the mode it sent while the daemon has not answered", async () => {
    const { reader } = await openWithHeldSelect();

    void reader.requestModeSelection(GIT_WORKSPACE, WORKTREE_MODE);
    await drain();

    // THE MODE AND NOT A FLAG: the rows go on showing the mode the workspace is bound
    // as now, so a picker that only greyed out would report nothing about what was
    // pressed.
    expect(reader.snapshot.pendingModeByWorkspaceId[GIT_WORKSPACE_ID]).toBe(WORKTREE_MODE);
  });

  it("refuses a second selection while one is unanswered, and issues no second call", async () => {
    // The defect: two selects issued before the first settles both run, and whichever
    // reaches the daemon LAST decides what the workspace is bound as — so a corrected
    // choice can lose to the one it corrected away from, silently, with both calls
    // reporting success.
    const { reader, port } = await openWithHeldSelect();
    void reader.requestModeSelection(GIT_WORKSPACE, WORKTREE_MODE);
    await drain();

    await reader.requestModeSelection(GIT_WORKSPACE, BRANCH_MODE);

    expect(port.selectCallCount()).toBe(1);
    const refusal = reader.snapshot.refusalByWorkspaceId[GIT_WORKSPACE_ID];
    expect(refusal?.code).toBe("selection-in-flight");
    // The sentence names the switch already on the wire — not the one just pressed and
    // not the mode the row is bound as.
    expect(refusal?.detail).toBe(selectionInFlightCopy(WORKTREE_MODE));
    expect(reader.snapshot.pendingModeByWorkspaceId[GIT_WORKSPACE_ID]).toBe(WORKTREE_MODE);
  });

  it("releases the picker and re-reads once the held switch settles", async () => {
    const { reader, clock, port } = await openWithHeldSelect();
    void reader.requestModeSelection(GIT_WORKSPACE, WORKTREE_MODE);
    await drain();
    const readsBefore = reader.performCount;

    port.release();
    await drain();

    expect(reader.snapshot.pendingModeByWorkspaceId[GIT_WORKSPACE_ID]).toBeUndefined();
    // Absent, never a held key with no value: the picker asks whether there IS an entry.
    expect(Object.keys(reader.snapshot.pendingModeByWorkspaceId)).toStrictEqual([]);
    // An accepted switch re-reads, because the workspace transitions
    // `ready -> provisioning -> ready` on its existing id and the row has to follow it.
    clock.advance(REFRESH_DEBOUNCE_MS);
    await drain();
    expect(reader.performCount).toBe(readsBefore + 1);
  });

  it("accepts the corrected choice once the first has settled", async () => {
    // The whole point of refusing the second press rather than dropping it: the
    // participant's correction is not lost, it is deferred to a picker that comes back.
    const { reader, port } = await openWithHeldSelect();
    void reader.requestModeSelection(GIT_WORKSPACE, WORKTREE_MODE);
    await drain();
    port.release();
    await drain();

    void reader.requestModeSelection(GIT_WORKSPACE, BRANCH_MODE);
    await drain();

    expect(port.selectCallCount()).toBe(2);
    expect(reader.snapshot.pendingModeByWorkspaceId[GIT_WORKSPACE_ID]).toBe(BRANCH_MODE);
  });

  it("negative control: another workspace's switch is neither held nor refused", async () => {
    // The register is keyed per workspace on purpose. Without this case a section-wide
    // register would satisfy every assertion above while refusing a press on a row that
    // cannot collide with the one waiting.
    const { reader, port } = await openWithHeldSelect();
    void reader.requestModeSelection(GIT_WORKSPACE, WORKTREE_MODE);
    await drain();

    void reader.requestModeSelection(PLAIN_WORKSPACE, BRANCH_MODE);
    await drain();

    expect(port.selectCallCount()).toBe(2);
    expect(reader.snapshot.refusalByWorkspaceId[PLAIN_WORKSPACE_ID]).toBeUndefined();
    expect(reader.snapshot.pendingModeByWorkspaceId).toStrictEqual({
      [GIT_WORKSPACE_ID]: WORKTREE_MODE,
      [PLAIN_WORKSPACE_ID]: BRANCH_MODE,
    });
  });

  it("leaves the daemon's own refusal on the row and releases the picker", async () => {
    // `Spec-010 §Required Behavior` forbids silent substitution, so a refused switch
    // does not re-pick and does not re-read — and the picker comes back, because
    // holding it after the answer arrived would strand the row on a switch that is over.
    const { reader, port } = await openWithHeldSelect("rejected");
    void reader.requestModeSelection(GIT_WORKSPACE, WORKTREE_MODE);
    await drain();
    const readsBefore = reader.performCount;

    port.release();
    await drain();

    expect(reader.snapshot.refusalByWorkspaceId[GIT_WORKSPACE_ID]?.code).toBe("workspace.busy");
    expect(reader.snapshot.pendingModeByWorkspaceId[GIT_WORKSPACE_ID]).toBeUndefined();
    expect(reader.performCount).toBe(readsBefore);
  });

  it("negative control: a reply landing after the section unmounted writes nothing", async () => {
    // Settled by liveness AND by request identity, asked in one place. The refusal arm
    // is the one that would WRITE — an accepted switch only asks a disposed scheduler
    // for a read it will not run — so this case takes it, and a continuation that
    // published on a torn-down section would move the snapshot here.
    const { reader, port } = await openWithHeldSelect("rejected");
    void reader.requestModeSelection(GIT_WORKSPACE, WORKTREE_MODE);
    await drain();
    const readingBefore = reader.snapshot;

    reader.dispose();
    port.release();
    await drain();

    expect(reader.snapshot).toBe(readingBefore);
    expect(reader.snapshot.refusalByWorkspaceId[GIT_WORKSPACE_ID]).toBeUndefined();
  });
});

describe("ExecutionModeSelections — a retry clears the refusal it is retrying", () => {
  it("shows no stale refusal while the retried switch is on the wire", async () => {
    // The defect: `#hold` published the pending mode and left the old entry in
    // `refusalByWorkspaceId`, so the picker showed the failure the participant had
    // just retried away from beside "Switching to …" for the whole flight — and, on an
    // accepted switch, until the follow-up read finished.
    const { reader, port } = await openWithHeldSelect(["rejected", "served"]);
    void reader.requestModeSelection(GIT_WORKSPACE, WORKTREE_MODE);
    await drain();
    port.release();
    await drain();
    expect(reader.snapshot.refusalByWorkspaceId[GIT_WORKSPACE_ID]?.code).toBe("workspace.busy");

    void reader.requestModeSelection(GIT_WORKSPACE, WORKTREE_MODE);
    await drain();

    expect(reader.snapshot.pendingModeByWorkspaceId[GIT_WORKSPACE_ID]).toBe(WORKTREE_MODE);
    // Absent, never a held key with no value — the picker asks whether there IS one.
    expect(reader.snapshot.refusalByWorkspaceId[GIT_WORKSPACE_ID]).toBeUndefined();
    expect(Object.keys(reader.snapshot.refusalByWorkspaceId)).toStrictEqual([]);
  });

  it("records the retry's own refusal when the retry is refused too", async () => {
    // Clearing on issue must not become swallowing: a retry that fails records its own
    // result, and the row ends holding the second answer rather than nothing.
    const { reader, port } = await openWithHeldSelect("rejected");
    void reader.requestModeSelection(GIT_WORKSPACE, WORKTREE_MODE);
    await drain();
    port.release();
    await drain();

    void reader.requestModeSelection(GIT_WORKSPACE, BRANCH_MODE);
    await drain();
    expect(reader.snapshot.refusalByWorkspaceId[GIT_WORKSPACE_ID]).toBeUndefined();
    port.release();
    await drain();

    expect(port.selectCallCount()).toBe(2);
    expect(reader.snapshot.refusalByWorkspaceId[GIT_WORKSPACE_ID]?.code).toBe("workspace.busy");
    expect(reader.snapshot.pendingModeByWorkspaceId[GIT_WORKSPACE_ID]).toBeUndefined();
  });

  it("negative control: issuing a switch clears no other workspace's refusal", async () => {
    // Without this the pair above would pass against a publish that emptied the whole
    // refusal map, which would take a row's daemon refusal off the screen because an
    // unrelated row was pressed.
    const { reader, port } = await openWithHeldSelect("rejected");
    void reader.requestModeSelection(GIT_WORKSPACE, WORKTREE_MODE);
    await drain();
    port.release();
    await drain();
    expect(reader.snapshot.refusalByWorkspaceId[GIT_WORKSPACE_ID]?.code).toBe("workspace.busy");

    void reader.requestModeSelection(PLAIN_WORKSPACE, BRANCH_MODE);
    await drain();

    expect(reader.snapshot.refusalByWorkspaceId[GIT_WORKSPACE_ID]?.code).toBe("workspace.busy");
    expect(reader.snapshot.pendingModeByWorkspaceId[PLAIN_WORKSPACE_ID]).toBe(BRANCH_MODE);
  });
});
