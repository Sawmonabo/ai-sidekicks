// Which half of the per-workspace refusals a read is allowed to rebuild.
//
// THE SEAM BETWEEN THE TWO CLASSES THAT WRITE THE READING, and the one bug it exists to
// keep fixed: `RepoMountsReader` rebuilds its refusal map from the capabilities loop on
// every pass, and `ExecutionModeSelections` writes the answer to a press. While those
// two shared one map, a lifecycle frame — a `workspace.stale` the participant did not
// cause and cannot see — silently deleted the sentence saying why their last press did
// nothing, because a served capabilities answer for that workspace overwrote it.
//
// CARRYING THE MAP FORWARD DOES NOT FIX IT, which is why the pair is split by
// PRODUCER rather than merged more carefully. After a served roster read every
// workspace key is one the capabilities loop answered for, so a rebuild-then-merge
// deletes exactly the entry that has to survive. The cases below assert both directions
// at once: the act's entry survives a read, and the read's entry at the same key does
// not — a pair that no single map can satisfy.

import { afterEach, describe, expect, it } from "vitest";

import type { ExecutionMode, SessionEventType, WorkspaceId } from "@ai-sidekicks/contracts";

import { createFixtureBridge, type ConsoleBridge } from "../../bridge/index.js";
import { withDaemonCall } from "../../bridge/fixture/fixture-bridge.test-support.js";
import { REPOS_SCENARIO } from "../../bridge/scenarios/repos.js";
import { GIT_WORKSPACE_ID } from "../../bridge/scenarios/repos-fixture-data.js";
import { ManualClock } from "../../core/index.js";
import { ParkedCalls } from "../held-calls.test-support.js";
import { SessionStore } from "../../store/index.js";
import { eventOfKind } from "../../store/session-event.test-support.js";
import { workspaceRefusalFor } from "./repo-mounts-model.js";
import { RepoMountsReader } from "./repo-mounts-reader.js";
import { drain, settle, trackReader, disposeTrackedReaders } from "./repo-mounts.test-support.js";

// Every reader a case opens is tracked, and none of them outlives its case.
afterEach(disposeTrackedReaders);

const MODE_SELECT_CALL = "repo.executionModeSelect";
const CAPABILITIES_READ_CALL = "repo.executionModeCapabilitiesRead";
const WORKSPACE_LIST_CALL = "repo.workspaceList";

const GIT_WORKSPACE = GIT_WORKSPACE_ID as WorkspaceId;
const WORKTREE_MODE = "worktree" satisfies ExecutionMode;

/** How a case reaches inside the fixture without scripting a whole second scenario. */
interface ReadUnderTest {
  readonly reader: RepoMountsReader;
  readonly clock: ManualClock;
  /** Deliver a lifecycle frame, which is the trigger the section re-reads on. */
  readonly deliverLifecycleFrame: (kind: SessionEventType) => void;
  /** Let every parked mode select through, in the order they were made. */
  readonly releaseSelects: () => void;
}

/** What the intercepting port does to the two calls a case bends. */
interface PortBehaviour {
  /** Park every mode select, so a second press lands while the first is unanswered. */
  readonly parkModeSelects?: boolean;
  /** Refuse this workspace's capabilities read on the first N reads, then serve it. */
  readonly refuseCapabilitiesForFirstReads?: number;
  /** Drop this workspace from the roster from the second read onwards. */
  readonly dropFromRosterAfterFirstRead?: boolean;
}

function interceptingBridge(behaviour: PortBehaviour, parked: ParkedCalls): ConsoleBridge {
  let rosterReads = 0;
  const held = withDaemonCall(
    createFixtureBridge({ scenario: REPOS_SCENARIO }),
    async (call, passThrough) => {
      if (call.method === WORKSPACE_LIST_CALL) {
        rosterReads += 1;
        const roster = (await passThrough()) as { workspaces: { id: string }[] };
        if (behaviour.dropFromRosterAfterFirstRead === true && rosterReads > 1) {
          return { workspaces: roster.workspaces.filter((row) => row.id !== GIT_WORKSPACE_ID) };
        }
        return roster;
      }
      if (
        call.method === CAPABILITIES_READ_CALL &&
        (call.params as { workspaceId?: string }).workspaceId === GIT_WORKSPACE_ID &&
        rosterReads <= (behaviour.refuseCapabilitiesForFirstReads ?? 0)
      ) {
        // A typed daemon refusal in the envelope shape the wire sends, which is what
        // the read half records into its own register.
        throw { code: "workspace.busy", message: "This workspace is provisioning." };
      }
      if (call.method === MODE_SELECT_CALL && behaviour.parkModeSelects === true) {
        await parked.park();
      }
      return await passThrough();
    },
  );
  return held.bridge;
}

/** A section that has read once, with the port bent however the case needs. */
async function openSection(behaviour: PortBehaviour = {}): Promise<ReadUnderTest> {
  const parked = new ParkedCalls();
  const clock = new ManualClock();
  const sessionStore = new SessionStore({ sessionId: REPOS_SCENARIO.sessionId });
  // A base state is what makes a later frame a frame rather than history.
  sessionStore.initialise({ cursor: 0, entities: [], participantJoinLog: [] });
  const bridge = interceptingBridge(behaviour, parked);
  const reader = new RepoMountsReader({ bridge, sessionStore, clock });
  trackReader(reader);
  reader.start();
  await settle(clock, reader);
  let sequence = 0;
  return {
    reader,
    clock,
    deliverLifecycleFrame: (kind) => {
      sequence += 1;
      sessionStore.applyBatch([eventOfKind(REPOS_SCENARIO.sessionId, kind, sequence)]);
    },
    releaseSelects: () => {
      parked.releaseAll();
    },
  };
}

describe("the per-workspace refusals — one half per producer", () => {
  it("leaves a refused mode switch standing through a lifecycle-triggered read", async () => {
    const section = await openSection({ parkModeSelects: true });

    void section.reader.requestModeSelection(GIT_WORKSPACE, WORKTREE_MODE);
    await drain();
    // The second press is the one that is refused: this workspace's own switch is
    // already on the wire.
    void section.reader.requestModeSelection(GIT_WORKSPACE, WORKTREE_MODE);
    await drain();
    expect(
      workspaceRefusalFor(section.reader.snapshot.workspaceRefusals, GIT_WORKSPACE_ID)?.code,
    ).toBe("selection-in-flight");

    // A frame the participant did not cause. This is the read that used to erase it.
    section.deliverLifecycleFrame("workspace.stale");
    await settle(section.clock, section.reader);

    const reading = section.reader.snapshot;
    expect(section.reader.performCount).toBe(2);
    // NON-VACUOUS BY CONSTRUCTION: the read ANSWERED for this workspace, which is the
    // exact condition under which one shared map deleted the entry.
    expect(reading.capabilitiesByWorkspaceId[GIT_WORKSPACE_ID]).toBeDefined();
    expect(workspaceRefusalFor(reading.workspaceRefusals, GIT_WORKSPACE_ID)?.code).toBe(
      "selection-in-flight",
    );

    section.releaseSelects();
    await drain();
  });

  it("clears a capabilities refusal on the read that answers for that workspace", async () => {
    // The other direction, and the reason the fix is a split rather than a carry: the
    // read's own half IS rebuilt whole, so a workspace the daemon has since answered
    // for stops carrying a stale sentence about a read that no longer fails.
    const section = await openSection({ refuseCapabilitiesForFirstReads: 1 });

    expect(
      section.reader.snapshot.workspaceRefusals.byCapabilitiesRead[GIT_WORKSPACE_ID]?.code,
    ).toBe("workspace.busy");
    // And with no press behind it, that is the refusal the row renders.
    expect(
      workspaceRefusalFor(section.reader.snapshot.workspaceRefusals, GIT_WORKSPACE_ID)?.code,
    ).toBe("workspace.busy");

    section.deliverLifecycleFrame("workspace.stale");
    await settle(section.clock, section.reader);

    const reading = section.reader.snapshot;
    expect(reading.workspaceRefusals.byCapabilitiesRead[GIT_WORKSPACE_ID]).toBeUndefined();
    expect(workspaceRefusalFor(reading.workspaceRefusals, GIT_WORKSPACE_ID)).toBeUndefined();
  });

  it("prefers the press's own refusal over the read's for the same workspace", async () => {
    const section = await openSection({
      parkModeSelects: true,
      refuseCapabilitiesForFirstReads: 1,
    });

    void section.reader.requestModeSelection(GIT_WORKSPACE, WORKTREE_MODE);
    await drain();
    void section.reader.requestModeSelection(GIT_WORKSPACE, WORKTREE_MODE);
    await drain();

    const reading = section.reader.snapshot;
    // Both halves hold an entry for this workspace, and the row shows the one about
    // what the participant just did.
    expect(reading.workspaceRefusals.byCapabilitiesRead[GIT_WORKSPACE_ID]?.code).toBe(
      "workspace.busy",
    );
    expect(workspaceRefusalFor(reading.workspaceRefusals, GIT_WORKSPACE_ID)?.code).toBe(
      "selection-in-flight",
    );

    section.releaseSelects();
    await drain();
  });

  it("drops a carried selection refusal for a workspace the roster no longer names", async () => {
    // Carrying the act's half forward is not carrying it forever: a workspace with no
    // row has nowhere to render its refusal, and an entry with no row is a leak that
    // grows for as long as the section stays mounted.
    const section = await openSection({
      parkModeSelects: true,
      dropFromRosterAfterFirstRead: true,
    });

    void section.reader.requestModeSelection(GIT_WORKSPACE, WORKTREE_MODE);
    await drain();
    void section.reader.requestModeSelection(GIT_WORKSPACE, WORKTREE_MODE);
    await drain();
    expect(section.reader.snapshot.workspaceRefusals.bySelection[GIT_WORKSPACE_ID]).toBeDefined();

    section.deliverLifecycleFrame("workspace.stale");
    await settle(section.clock, section.reader);

    const reading = section.reader.snapshot;
    expect(reading.workspaces.some((row) => row.id === GIT_WORKSPACE_ID)).toBe(false);
    expect(reading.workspaceRefusals.bySelection[GIT_WORKSPACE_ID]).toBeUndefined();

    section.releaseSelects();
    await drain();
  });
});
