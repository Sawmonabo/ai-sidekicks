// What a capture is allowed to contain, and when it may be replaced.
//
// Split from `process-tree-identity.test.ts` beside it because it is a different
// question with a different failure. That file asks whether the root pid still
// names the same PROCESS; this one takes that answer as given and asks about the
// set the answer produces — the only handle a rootless tree has once its root is
// gone. Each of its subjects is a way that set can be wrong while every stamp
// comparison over there passes: a row that was never this tree's admitted into
// it, a verified set erased by a reading that failed, and a set GROWN by the one
// reading taken after the number stopped being this tree's to read.

import { describe, expect, it } from "vitest";

import { SpawnedTreeIdentity } from "./process-tree/identity.js";
import { type ProcessTableRow } from "./process-tree/readers.js";
import { startStampPrecedes, verifyCapturedMembers } from "./process-tree/start-stamps.js";
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

describe("process termination — the reading after the root's exit may only remove", () => {
  // THE FINDING, AND IT IS A WINDOW RATHER THAN A COMPARISON. The refresh that
  // ran at the root's `exit` RECORDED what the listing said, and by that event
  // the process has been reaped: Node has closed the handle it held, so from
  // that instant the operating system may hand the number to something else. A
  // listing taken from there can carry rows a NEW holder of the number fathered
  // inside the window the listing itself takes, and nothing in such a row tells
  // them apart from this tree's — same parent pid, and a start stamp AFTER the
  // original root's, so the ancestry proof next door admits them. Handed to
  // `taskkill /t`, that is an unrelated tree this package never spawned.
  //
  // No filter over the rows closes it, which is why the fix is a rule about
  // WHEN: the set is recorded while the root is verifiably still held, and the
  // exit-time reading is narrowed to an INTERSECTION that can only remove.

  /** The reused number's new holder, and the two children it has started since. */
  const NEW_HOLDER_CHILD_PID = 5551;
  const NEW_HOLDER_GRANDCHILD_PID = 5552;
  const AFTER_THE_EXIT_TICKS = "638700000000000000";

  /** An identity whose live capture has already recorded one genuine descendant. */
  function identityCapturedThenSeeing(
    laterTable: ReadonlyMap<number, ProcessTableRow> | undefined,
  ): SpawnedTreeIdentity {
    let table: ReadonlyMap<number, ProcessTableRow> | undefined = processTableOf([
      [CAPTURED_CHILD_PID, CAPTURED_ROOT_PID, GENUINE_CHILD_TICKS],
    ]);
    const identity = new SpawnedTreeIdentity(
      CAPTURED_ROOT_PID,
      new ScriptedStartStamps([ROOT_TICKS, ROOT_TICKS]).read,
      () => table,
      () => true,
    );
    identity.captureLiveDescendants();
    expect(identity.capturedDescendants.map((member) => member.processId)).toStrictEqual([
      CAPTURED_CHILD_PID,
    ]);
    table = laterTable;
    return identity;
  }

  it("admits nothing the live capture did not already name", () => {
    // The whole defect in one table: the root's number has been reissued, and
    // its new holder has children of its own whose stamps postdate the original
    // root. A capture taken here records them; an intersection cannot.
    const identity = identityCapturedThenSeeing(
      processTableOf([
        [CAPTURED_CHILD_PID, CAPTURED_ROOT_PID, GENUINE_CHILD_TICKS],
        [NEW_HOLDER_CHILD_PID, CAPTURED_ROOT_PID, AFTER_THE_EXIT_TICKS],
        [NEW_HOLDER_GRANDCHILD_PID, NEW_HOLDER_CHILD_PID, AFTER_THE_EXIT_TICKS],
      ]),
    );

    identity.narrowCapturedDescendants();

    expect(
      identity.capturedDescendants.map((member) => member.processId),
      "the exit-time reading admitted a process the reused pid's new holder started — the rootless kill list now addresses a tree this package never spawned",
    ).toStrictEqual([CAPTURED_CHILD_PID]);
  });

  it("drops a captured member whose number has since been handed to a stranger", () => {
    // The one thing an intersection IS for. The member is still listed, so a
    // liveness pass would keep addressing it, and the pid is now a stranger's.
    const identity = identityCapturedThenSeeing(
      processTableOf([[CAPTURED_CHILD_PID, 1, AFTER_THE_EXIT_TICKS]]),
    );

    identity.narrowCapturedDescendants();

    expect(identity.capturedDescendants).toStrictEqual([]);
  });

  it("keeps the set when the exit-time listing cannot be read at all", () => {
    // The sentinel again, and the same trade the live capture takes: a reading
    // that did not happen removes nobody, because stale-and-addressable beats
    // verified-and-erased on exactly the host whose readings do not work.
    const identity = identityCapturedThenSeeing(undefined);

    identity.narrowCapturedDescendants();

    expect(identity.capturedDescendants.map((member) => member.processId)).toStrictEqual([
      CAPTURED_CHILD_PID,
    ]);
  });

  it("spends no host query when nothing was captured", () => {
    // The POSIX teardown is this case on every run: nothing is ever captured
    // there, and an intersection over no members can remove nobody — so the
    // blocking listing is not taken, rather than taken and discarded.
    let listings = 0;
    const identity = new SpawnedTreeIdentity(
      CAPTURED_ROOT_PID,
      new ScriptedStartStamps([ROOT_TICKS]).read,
      () => {
        listings += 1;
        return processTableOf([[NEW_HOLDER_CHILD_PID, CAPTURED_ROOT_PID, AFTER_THE_EXIT_TICKS]]);
      },
      () => true,
    );

    identity.narrowCapturedDescendants();

    expect(identity.capturedDescendants).toStrictEqual([]);
    expect(listings, "an empty capture still paid for a host listing it could not consult").toBe(0);
  });
});
