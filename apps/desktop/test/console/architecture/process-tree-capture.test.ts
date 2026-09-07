// What a capture is allowed to contain, and when it may be replaced.
//
// Split from `process-tree-identity.test.ts` beside it because it is a different
// question with a different failure. That file asks whether the root pid still
// names the same PROCESS; this one takes that answer as given and asks about the
// set the answer produces — the only handle a rootless tree has once its root is
// gone. Both of its subjects are ways that set can be wrong while every stamp
// comparison over there passes: a row that was never this tree's admitted into
// it, and a verified set erased by a reading that failed.

import { describe, expect, it } from "vitest";

import {
  SpawnedTreeIdentity,
  startStampPrecedes,
  verifyCapturedMembers,
} from "../../helpers/process-tree/identity.js";
import { type ProcessTableRow } from "../../helpers/process-tree/readers.js";
import {
  CAPTURED_CHILD_PID,
  CAPTURED_ROOT_PID,
  CAPTURED_TREE_TABLE,
  CHILD_STAMP,
  ScriptedStartStamps,
} from "./process-tree-identity.test-support.js";
import { processTableOf } from "./process-table-fixture.test-support.js";

/**
 * The tick-shaped stamps the ancestry cases are ordered by.
 *
 * `CreationDate.Ticks` is what the Windows listing emits and this is the
 * platform the ancestry proof is FOR, so the stale-claimant cases are written in
 * its own spelling rather than in a shape only this suite would ever see. The
 * genuine child is one tick after its root, which is the tightest ordering the
 * platform can express and the one a comparison written with `<=` would fail.
 */
const ROOT_TICKS = "638600000000000000";
const GENUINE_CHILD_TICKS = "638600000000000001";
const CLAIMANT_TICKS = "638500000000000000";

/** A process that outlived the pid's FORMER holder, and a child it started since. */
const STALE_CLAIMANT_PID = 4245;
const STALE_CLAIMANT_CHILD_PID = 4246;

describe("process termination — a claimant that predates the root was never this tree's", () => {
  // THE FINDING. Windows does not reparent, so a process whose parent exited
  // keeps naming that parent's number for as long as it runs — including once
  // the number has been handed to this tree's root. Its row is byte for byte a
  // descendant's row, and the stamp check next door passes it: the claimant is
  // still itself, it was simply never ours. Captured, it becomes a member of the
  // rootless kill list and `taskkill` takes an unrelated long-lived process.
  //
  // The separating fact is an ORDER and not an equality, and it is the one rule
  // about parenthood no kernel breaks: a child cannot have started before its
  // parent.

  /** The root's own stamp, taken at construction, read twice per case. */
  function identityOverTable(
    table: ReadonlyMap<number, ProcessTableRow>,
    rootStamp: string,
  ): SpawnedTreeIdentity {
    return new SpawnedTreeIdentity(
      CAPTURED_ROOT_PID,
      new ScriptedStartStamps([rootStamp, rootStamp]).read,
      () => table,
      () => true,
    );
  }

  it("keeps the child started after the root and drops the claimant started before it", () => {
    const identity = identityOverTable(
      processTableOf([
        [CAPTURED_CHILD_PID, CAPTURED_ROOT_PID, GENUINE_CHILD_TICKS],
        [STALE_CLAIMANT_PID, CAPTURED_ROOT_PID, CLAIMANT_TICKS],
      ]),
      ROOT_TICKS,
    );

    expect(identity.readIdentity()).toBe("same");
    expect(
      identity.capturedDescendants,
      "a process that predates this root was captured as its descendant — the rootless kill list is being handed a stranger",
    ).toStrictEqual([{ processId: CAPTURED_CHILD_PID, startStamp: GENUINE_CHILD_TICKS }]);
  });

  it("drops what the claimant started too, because a stranger's child is a stranger", () => {
    // The pruning is of the TABLE and not of the walk's result, which is the
    // whole difference here: the claimant's own child was started after this
    // root, so its stamp proves nothing at all — what convicts it is the row it
    // hangs off, and a post-filter over the walk would keep it while dropping the
    // only row that explains where it came from.
    const identity = identityOverTable(
      processTableOf([
        [CAPTURED_CHILD_PID, CAPTURED_ROOT_PID, GENUINE_CHILD_TICKS],
        [STALE_CLAIMANT_PID, CAPTURED_ROOT_PID, CLAIMANT_TICKS],
        [STALE_CLAIMANT_CHILD_PID, STALE_CLAIMANT_PID, GENUINE_CHILD_TICKS],
      ]),
      ROOT_TICKS,
    );

    expect(identity.readIdentity()).toBe("same");
    expect(identity.capturedDescendants.map((member) => member.processId)).toStrictEqual([
      CAPTURED_CHILD_PID,
    ]);
  });

  it("negative control: a row it cannot place in the root's order is kept, not dropped", () => {
    // THE FAILURE DIRECTION, and the reason this control is the one that matters.
    // A prune that fired on an unreadable stamp would empty the only handle a
    // rootless tree has on exactly the host whose readings do not work — which
    // is a larger failure than the one above, and the same trade this module
    // takes at every other stamp comparison. Three doubts in one table: no stamp
    // at all, a stamp in an order this does not recognise, and a stamp in the
    // OTHER recognised order.
    const identity = identityOverTable(
      processTableOf([
        [CAPTURED_CHILD_PID, CAPTURED_ROOT_PID, undefined],
        [STALE_CLAIMANT_PID, CAPTURED_ROOT_PID, "child-at-spawn"],
        [STALE_CLAIMANT_CHILD_PID, CAPTURED_ROOT_PID, "Sun Sep  7 02:25:10 2026"],
      ]),
      ROOT_TICKS,
    );

    expect(identity.readIdentity()).toBe("same");
    expect(identity.capturedDescendants.map((member) => member.processId).sort()).toStrictEqual([
      CAPTURED_CHILD_PID,
      STALE_CLAIMANT_PID,
      STALE_CLAIMANT_CHILD_PID,
    ]);
  });

  it("orders the two stamp spellings this package reads, and refuses to order anything else", () => {
    // The proof itself, driven directly. `<` and not `<=`, because `ps -o lstart=`
    // resolves to the second: a child started inside its parent's second reads
    // EQUAL, and equal is not evidence of predating anything.
    expect(startStampPrecedes(CLAIMANT_TICKS, ROOT_TICKS)).toBe(true);
    expect(startStampPrecedes(GENUINE_CHILD_TICKS, ROOT_TICKS)).toBe(false);
    expect(startStampPrecedes(ROOT_TICKS, ROOT_TICKS)).toBe(false);
    expect(startStampPrecedes("Sun Sep  7 02:25:09 2026", "Sun Sep  7 02:25:10 2026")).toBe(true);
    expect(startStampPrecedes("Sun Sep  7 02:25:10 2026", "Sun Sep  7 02:25:10 2026")).toBe(false);
    // Eighteen digits is past what a double holds exactly, so a comparison that
    // read these as numbers would call two different ticks the same instant.
    expect(startStampPrecedes("638600000000000000", "638600000000000001")).toBe(true);
    // And the pairs it must refuse: either side missing, an unrecognised
    // spelling, and — the one that would answer confidently and mean nothing —
    // a tick count against a calendar instant.
    expect(startStampPrecedes(undefined, ROOT_TICKS)).toBe(false);
    expect(startStampPrecedes(CLAIMANT_TICKS, undefined)).toBe(false);
    expect(startStampPrecedes("child-at-spawn", ROOT_TICKS)).toBe(false);
    expect(startStampPrecedes("Sun Sep  7 02:25:10 2026", ROOT_TICKS)).toBe(false);
  });
});

describe("process termination — an unreadable refresh must not erase the capture", () => {
  // THE FINDING. The refresh that runs at the root's `exit` is the last chance
  // this tree has to record what it is made of, and it reads the host to do it.
  // A read that times out or will not start answers with the unreadable
  // SENTINEL — and assigning that answer replaced a verified capture with
  // nothing at precisely the moment it became the only handle: the launcher is
  // gone, the browser it started is alive, and the rootless arm is handed no
  // member to address, so it refuses every attempt and the browser outlives the
  // run.
  //
  // The sentinel is what makes that separable at all, and it is the same value
  // the verdict path fails closed on: a listing that RAN and named no
  // descendant is a reading and does shrink the set, while one that did not run
  // is no reading. Stale and addressable beats verified and erased; a member
  // that has since exited is filtered by the caller's own liveness pass either
  // way.

  const capturedTree = [{ processId: CAPTURED_CHILD_PID, startStamp: CHILD_STAMP }];

  /** A verified identity holding one captured descendant, over a swappable table. */
  function identityAfterAVerifiedCapture(
    readTable: () => ReadonlyMap<number, ProcessTableRow> | undefined,
  ): {
    readonly identity: SpawnedTreeIdentity;
  } {
    const identity = new SpawnedTreeIdentity(
      CAPTURED_ROOT_PID,
      new ScriptedStartStamps(["stamp-at-spawn", "stamp-at-spawn"]).read,
      readTable,
      () => true,
    );
    expect(identity.readIdentity()).toBe("same");
    expect(identity.capturedDescendants).toStrictEqual(capturedTree);
    return { identity };
  }

  it("keeps the last verified set when the refresh cannot read the host", () => {
    let table: ReadonlyMap<number, ProcessTableRow> | undefined = CAPTURED_TREE_TABLE;
    const { identity } = identityAfterAVerifiedCapture(() => table);

    // The root exits, and the listing taken to record its tree does not answer.
    table = undefined;
    identity.captureLiveDescendants();

    expect(
      identity.capturedDescendants,
      "an unreadable refresh erased the verified capture — the rootless arm has nothing left to address",
    ).toStrictEqual(capturedTree);
    // And what survived is still a KILL LIST rather than a remembered number:
    // the pair verifies against the table the arm will read it under.
    expect(verifyCapturedMembers(identity.capturedDescendants, CAPTURED_TREE_TABLE)).toStrictEqual([
      CAPTURED_CHILD_PID,
    ]);
  });

  it("negative control: a readable refresh that lists no descendant does shrink the set", () => {
    // Without this the case above is ambiguous between "an unreadable refresh is
    // ignored" and "the capture only ever grows", and the second would keep
    // addressing a tree the host has demonstrably reported as gone — turning
    // every later disposal into a walk over pids nothing claims. Both foils are
    // driven, because the sentinel is what separates them: a listing carrying
    // an unrelated row, and one carrying no row at all. The second passed only
    // while emptiness was being read as unreadability, which is the inference
    // the sentinel replaces.
    for (const readableListing of [processTableOf([[9999, 1, "unrelated"]]), processTableOf([])]) {
      let table: ReadonlyMap<number, ProcessTableRow> | undefined = CAPTURED_TREE_TABLE;
      const { identity } = identityAfterAVerifiedCapture(() => table);

      table = readableListing;
      identity.captureLiveDescendants();

      expect(identity.capturedDescendants).toStrictEqual([]);
    }
  });
});
