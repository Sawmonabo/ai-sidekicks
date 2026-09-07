// The scripted root a capture is driven against, and the tree it names.
//
// Two suites drive `SpawnedTreeIdentity` and they ask different questions of it:
// `process-tree-identity.test.ts` asks whether the root pid still names the same
// process, and `process-tree-capture.test.ts` asks what the descendant set is
// allowed to contain and when it may be replaced. Both need a root whose stamp
// answers on a script and a tree whose rows are known, so those live here rather
// than in whichever file happened to be written first.
//
// A STAND-IN AND NOT A FIXTURE CONSTRUCTOR, which is why it is not folded into
// `process-table-fixture.test-support.ts` beside it. That module builds table
// DATA and decides nothing; this one answers a reading in place of the platform,
// which is a different role and the reason the two are separate homes.

import { type ProcessTableRow } from "../../helpers/process-tree/readers.js";
import { processTableOf } from "./process-table-fixture.test-support.js";

/** The tree whose root is captured, and the one descendant it is known to hold. */
export const CAPTURED_ROOT_PID: number = 4242;
export const CAPTURED_CHILD_PID: number = 4243;

/** The stamp the descendant is listed under while it is still itself. */
export const CHILD_STAMP: string = "child-at-spawn";

/** The listing taken while the root was verifiably this tree's. */
export const CAPTURED_TREE_TABLE: ReadonlyMap<number, ProcessTableRow> = processTableOf([
  [CAPTURED_CHILD_PID, CAPTURED_ROOT_PID, CHILD_STAMP],
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
 *
 * Exported because both suites take a scripted root: the reissue cases over
 * there, and the ancestry proof and the refresh that could not read next door.
 */
export class ScriptedStartStamps {
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
