// A pid is a NAME, and the operating system hands it back out.
//
// Split from `process-tree.test.ts` beside it because it is a different subject
// with a different instrument. That file asks what a pid is DOING — does it name
// anything, is what it names still able to run — and answers with probes over one
// moment. This one asks whether the pid still names the same PROCESS across two
// moments, which is the question every reading over there quietly assumed an
// answer to: the launcher shim exits early and is reaped, so the number a tree is
// addressed through can belong to somebody else by the time a disposal runs.
//
// WHAT CANNOT BE PROVOKED. Pid reuse is the kernel's own bookkeeping — a test can
// neither ask for a number back nor wait out a wrap of the pid space — so the
// stamp reading is injected and the real platform arm is checked separately,
// against the two pids whose answers are already known: this process, and one
// that has certainly exited.

import { spawnSync } from "node:child_process";
import process from "node:process";

import { describe, expect, it } from "vitest";

import { readProcessStartStamp, SpawnedTreeIdentity } from "../../helpers/process-tree.js";

describe("process termination — a pid is a NAME, and the operating system reissues it", () => {
  // WHY THIS IS SCRIPTED AND NOT PROVOKED. The state under test is a pid whose
  // holder CHANGED between two moments, and pid reuse is the kernel's own
  // bookkeeping: a test cannot ask for the number back, and waiting for a wrap
  // around the pid space is not a test. So the stamp reading is injected and the
  // real platform arm is checked separately, against the two pids whose answers
  // are already known — this process, and one that has certainly exited.

  /** The tree whose root is captured, and the one descendant it is known to hold. */
  const CAPTURED_ROOT_PID = 4242;
  const CAPTURED_CHILD_PID = 4243;
  /** A child of whoever holds the root's number after the reissue. */
  const IMPOSTOR_CHILD_PID = 4244;

  const CAPTURED_TREE_TABLE: ReadonlyMap<number, number> = new Map([
    [CAPTURED_CHILD_PID, CAPTURED_ROOT_PID],
  ]);
  const REISSUED_ROOT_TABLE: ReadonlyMap<number, number> = new Map([
    [IMPOSTOR_CHILD_PID, CAPTURED_ROOT_PID],
  ]);

  /**
   * A start-stamp reader whose answers are scripted in order.
   *
   * A queue rather than a value for `ScriptedLivenessProbes`' reason: the whole
   * subject is a SEQUENCE — the stamp taken at the spawn against the stamp taken
   * before the kill — and only what the later answer says separates the cases. A
   * read past the script throws rather than repeating, because a reading that
   * asks more often than the case described is a different reading; `undefined`
   * is a legitimate scripted answer, so the bound is checked before the take
   * rather than inferred from one.
   */
  class ScriptedStartStamps {
    readonly #answers: readonly (string | undefined)[];
    readonly #reads: number[] = [];
    #taken = 0;

    constructor(answers: readonly (string | undefined)[]) {
      this.#answers = [...answers];
    }

    /** The pids the reading asked about, in order. */
    get reads(): readonly number[] {
      return this.#reads;
    }

    readonly read = (processId: number): string | undefined => {
      if (this.#taken >= this.#answers.length) {
        throw new Error(
          `the identity asked for a start stamp ${String(this.#taken + 1)} times, past the ${String(this.#answers.length)} this case scripted`,
        );
      }
      this.#reads.push(processId);
      const answer = this.#answers[this.#taken];
      this.#taken += 1;
      return answer;
    };
  }

  it("captures the root's stamp at construction rather than at the kill", () => {
    // THE PROPERTY THE WHOLE FIX RESTS ON. A capture taken when the kill is
    // issued compares the pid against itself an instant later and answers `same`
    // for every pid on the host — a check that cannot fail wearing the shape of
    // one that can. The construction read is what makes the later comparison
    // mean anything, so it is asserted as a MOMENT and not only as a value.
    const stamps = new ScriptedStartStamps(["stamp-at-spawn", "stamp-at-spawn"]);
    const identity = new SpawnedTreeIdentity(
      CAPTURED_ROOT_PID,
      stamps.read,
      () => CAPTURED_TREE_TABLE,
      () => true,
    );

    expect(
      stamps.reads,
      "no stamp was taken at construction — the capture is being deferred to the kill, where it verifies nothing",
    ).toStrictEqual([CAPTURED_ROOT_PID]);
    expect(identity.readIdentity()).toBe("same");
    expect(stamps.reads).toStrictEqual([CAPTURED_ROOT_PID, CAPTURED_ROOT_PID]);
    expect(identity.capturedDescendants).toStrictEqual([CAPTURED_CHILD_PID]);
  });

  it("reads a reissued pid as recycled, and keeps the capture taken while it was ours", () => {
    // THE FINDING. Between the two readings the root exited, was reaped, and its
    // number went to somebody else — so the parent table now hangs the
    // STRANGER's child off that pid. A capture refreshed there would hand the
    // termination arm a pid to kill that this package never started, which is
    // the same defect as signalling the root, one indirection along.
    let parentTable: ReadonlyMap<number, number> = CAPTURED_TREE_TABLE;
    const stamps = new ScriptedStartStamps(["stamp-at-spawn", "stamp-at-spawn", "somebody-else"]);
    const identity = new SpawnedTreeIdentity(
      CAPTURED_ROOT_PID,
      stamps.read,
      () => parentTable,
      () => true,
    );

    expect(identity.readIdentity()).toBe("same");
    expect(identity.capturedDescendants).toStrictEqual([CAPTURED_CHILD_PID]);

    parentTable = REISSUED_ROOT_TABLE;

    expect(identity.readIdentity()).toBe("recycled");
    expect(
      identity.capturedDescendants,
      "the capture was refreshed under a reissued pid — the arm is being handed a stranger's child to kill",
    ).toStrictEqual([CAPTURED_CHILD_PID]);
  });

  it("reads a pid that names nothing as gone, without asking for a stamp at all", () => {
    // Existence decides this one and the stamp is never consulted, which is the
    // ORDER rather than an economy: a stamp that could not be read on a live
    // process is an unreadable probe, and answering `gone` to that would skip the
    // one walk that reaches the tree. The script is one answer long, so a reading
    // that asked anyway throws instead of passing quietly.
    const stamps = new ScriptedStartStamps(["stamp-at-spawn"]);
    const identity = new SpawnedTreeIdentity(
      CAPTURED_ROOT_PID,
      stamps.read,
      () => CAPTURED_TREE_TABLE,
      () => false,
    );

    expect(identity.readIdentity()).toBe("gone");
    expect(stamps.reads).toStrictEqual([CAPTURED_ROOT_PID]);
  });

  it("degrades to the pre-identity reading when no stamp can be read, and captures nothing there", () => {
    // The honest failure direction on a host whose stamp probe does not work.
    // Refusing every kill there would leak every tree on that host, which is a
    // larger failure than the one this reading closes — and detection is
    // impossible by construction rather than by choice. What it must NOT do is
    // spend a parent-table read per attempt building a capture that the recycled
    // arm, which it can never reach, is the only consumer of.
    let parentTableReads = 0;
    const stamps = new ScriptedStartStamps([undefined, undefined]);
    const identity = new SpawnedTreeIdentity(
      CAPTURED_ROOT_PID,
      stamps.read,
      () => {
        parentTableReads += 1;
        return CAPTURED_TREE_TABLE;
      },
      () => true,
    );

    expect(identity.readIdentity()).toBe("same");
    expect(
      parentTableReads,
      "an unverifiable identity captured a descendant set nothing can ever consume",
    ).toBe(0);
    expect(identity.capturedDescendants).toStrictEqual([]);
  });

  it("negative control: an unverified tree asks the platform for no stamp and reads `same`", () => {
    // The named degradation `terminateProcessTree` defaults to, driven rather
    // than described. Without this the cases above are ambiguous between "the
    // reading compares stamps" and "the reading always compares stamps", and the
    // second would make every caller that holds no spawn moment — `BoundedCleanup`,
    // handed a pid by Playwright — unable to kill anything at all.
    expect(SpawnedTreeIdentity.unverified(process.pid).readIdentity()).toBe("same");
    expect(SpawnedTreeIdentity.unverified(process.pid).capturedDescendants).toStrictEqual([]);

    const reaped = spawnSync(process.execPath, ["-e", ""]);
    expect(reaped.pid).toBeGreaterThan(0);
    expect(SpawnedTreeIdentity.unverified(reaped.pid).readIdentity()).toBe("gone");
  });

  it("reads a stable stamp for this very process, through the real platform arm", () => {
    // The half no scripted reader can claim: that this platform HAS such a
    // reading and that two reads of it agree. A stamp that moved between reads
    // would report every root as recycled and refuse every kill on the host, so
    // stability is the property rather than a detail of the format.
    const stamp = readProcessStartStamp(process.pid);
    expect(stamp).toBeTypeOf("string");
    expect(stamp).not.toBe("");
    expect(readProcessStartStamp(process.pid)).toBe(stamp);
  });

  it("reads no stamp for a pid that names nothing, and none for the group-addressing 0", () => {
    // `spawnSync` returns only once its child is gone, so its pid names a process
    // that certainly ran and certainly is not running. `0` is the same foil the
    // group probe above refuses: on POSIX it addresses the CALLER, and a stamp
    // read for it would identify this runner as the spawned tree's root.
    const reaped = spawnSync(process.execPath, ["-e", ""]);
    expect(reaped.pid).toBeGreaterThan(0);
    expect(readProcessStartStamp(reaped.pid)).toBeUndefined();
    expect(readProcessStartStamp(0)).toBeUndefined();
  });
});
