// What a capture is allowed to contain, and when it may be replaced.
//
// Split from `process-tree-identity.test.ts`, which asks whether the root pid still names the same
// process. This takes that answer as given and asks about the set it produces, the only handle a
// rootless tree has once its root is gone. Each subject is a way that set can be wrong while every
// stamp comparison there passes: a row never this tree's admitted, a verified set erased by a
// failed reading, and a set grown by the one reading taken after the number stopped being this
// tree's to read.

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
 * The tick-shaped stamps the ancestry cases are ordered by. `CreationDate.Ticks` is what the
 * Windows listing emits, and the ancestry proof is for that platform. The genuine child is one
 * tick after its root, the tightest ordering it can express and the one a `<=` comparison would
 * fail.
 */
const ROOT_TICKS = "638600000000000000";
const GENUINE_CHILD_TICKS = "638600000000000001";
const CLAIMANT_TICKS = "638500000000000000";

/** A process that outlived the pid's former holder, and a child it started since. */
const STALE_CLAIMANT_PID = 4245;
const STALE_CLAIMANT_CHILD_PID = 4246;

describe("process termination — a claimant that predates the root was never this tree's", () => {
  // Windows does not reparent, so a process whose parent exited keeps naming that parent's number
  // while it runs, including once the number is handed to this tree's root. Its row matches a
  // descendant's and passes the start-stamp check, since the claimant is still itself; captured,
  // it enters the rootless kill list and `taskkill` takes an unrelated long-lived process. The
  // separating fact is an order, the one rule about parenthood no kernel breaks: a child cannot
  // have started before its parent.

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
    // The pruning is of the table, not the walk's result: the claimant's child started after this
    // root, so its stamp proves nothing. What convicts it is the row it hangs off, and a
    // post-filter would keep it.
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
    // The failure direction: a prune that fired on an unreadable stamp would empty the only handle
    // a rootless tree has on exactly the host whose readings do not work. Three doubts in one
    // table: no stamp, an unrecognized order, and the other recognized order.
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
    // The proof, driven directly. `<` not `<=`, because `ps -o lstart=` resolves to the second: a
    // child started inside its parent's second reads equal, and equal is no evidence of predating.
    expect(startStampPrecedes(CLAIMANT_TICKS, ROOT_TICKS)).toBe(true);
    expect(startStampPrecedes(GENUINE_CHILD_TICKS, ROOT_TICKS)).toBe(false);
    expect(startStampPrecedes(ROOT_TICKS, ROOT_TICKS)).toBe(false);
    expect(startStampPrecedes("Sun Sep  7 02:25:09 2026", "Sun Sep  7 02:25:10 2026")).toBe(true);
    expect(startStampPrecedes("Sun Sep  7 02:25:10 2026", "Sun Sep  7 02:25:10 2026")).toBe(false);
    // Eighteen digits is past what a double holds exactly, so a numeric comparison would call two
    // different ticks the same instant.
    expect(startStampPrecedes("638600000000000000", "638600000000000001")).toBe(true);
    // The pairs it must refuse: either side missing, an unrecognized spelling, and a tick count
    // against a calendar instant, which would answer confidently and mean nothing.
    expect(startStampPrecedes(undefined, ROOT_TICKS)).toBe(false);
    expect(startStampPrecedes(CLAIMANT_TICKS, undefined)).toBe(false);
    expect(startStampPrecedes("child-at-spawn", ROOT_TICKS)).toBe(false);
    expect(startStampPrecedes("Sun Sep  7 02:25:10 2026", ROOT_TICKS)).toBe(false);
  });
});

describe("process termination — an unreadable refresh must not erase the capture", () => {
  // The refresh at the root's `exit` is the last chance to record what the tree is made of. A
  // read that times out or will not start answers with the unreadable sentinel, and assigning it
  // replaced a verified capture with nothing exactly when it became the only handle: the launcher
  // is gone, the browser is alive, and the rootless arm has no member to address. The sentinel
  // separates the cases: a listing that ran and named no descendant is a reading and shrinks the
  // set; one that did not run is no reading. Stale and addressable beats verified and erased, and
  // a member that has exited is filtered by the caller's liveness pass either way.

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
    // What survived is still a kill list: the pair verifies against the table the arm will read it
    // under.
    expect(verifyCapturedMembers(identity.capturedDescendants, CAPTURED_TREE_TABLE)).toStrictEqual([
      CAPTURED_CHILD_PID,
    ]);
  });

  it("negative control: a readable refresh that lists no descendant does shrink the set", () => {
    // Guards the case above against "the capture only ever grows", which would keep addressing a
    // tree the host reported gone. Both foils are driven because the sentinel separates them: a
    // listing with an unrelated row, and one with no row, which passed only while emptiness was
    // read as unreadability.
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
  // A window, not a comparison. By the root's `exit` the process is reaped and the OS may hand the
  // number to something else, so a listing from there can carry rows a new holder fathered,
  // indistinguishable from this tree's (same parent pid, a start stamp after the original root's)
  // and handed to `taskkill /t` they are an unrelated tree. No row filter closes it, so the fix is
  // a rule about when: the set is recorded while the root is verifiably held, and the exit-time
  // reading is an intersection that can only remove.

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
    // The root's number has been reissued and its new holder has children whose stamps postdate
    // the original root: a capture here records them, an intersection cannot.
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
    // What an intersection is for: the member is still listed, but its pid is now a stranger's.
    const identity = identityCapturedThenSeeing(
      processTableOf([[CAPTURED_CHILD_PID, 1, AFTER_THE_EXIT_TICKS]]),
    );

    identity.narrowCapturedDescendants();

    expect(identity.capturedDescendants).toStrictEqual([]);
  });

  it("keeps the set when the exit-time listing cannot be read at all", () => {
    // Same trade as the live capture: a reading that did not happen removes nobody.
    const identity = identityCapturedThenSeeing(undefined);

    identity.narrowCapturedDescendants();

    expect(identity.capturedDescendants.map((member) => member.processId)).toStrictEqual([
      CAPTURED_CHILD_PID,
    ]);
  });

  it("spends no host query when nothing was captured", () => {
    // The POSIX teardown is this case on every run: nothing is captured there, so the blocking
    // listing is not taken.
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
