// The scripted root a capture is driven against, and the tree it names.
//
// `process-tree-identity.test.ts` asks whether the root pid still names the same process, and
// `process-tree-capture.test.ts` asks what the descendant set may contain and when it may be
// replaced; both need a root whose stamp answers on a script and a tree with known rows. This
// module answers a reading in place of the platform, unlike
// `process-table-fixture.test-support.ts`, which builds table data and decides nothing.

import { type ProcessTableRow } from "./process-tree/readers.js";
import { processTableOf } from "./process-table-fixture.test-support.js";

/** The pid of the tree's captured root. */
export const CAPTURED_ROOT_PID: number = 4242;

/** The one descendant the captured tree is known to hold. */
export const CAPTURED_CHILD_PID: number = 4243;

/** The stamp the descendant is listed under while it is still itself. */
export const CHILD_STAMP: string = "child-at-spawn";

/** The listing taken while the root was verifiably this tree's. */
export const CAPTURED_TREE_TABLE: ReadonlyMap<number, ProcessTableRow> = processTableOf([
  [CAPTURED_CHILD_PID, CAPTURED_ROOT_PID, CHILD_STAMP],
]);

/**
 * A start-stamp reader whose answers are scripted in order. It is a queue because the subject is
 * a sequence: the stamp taken at the spawn against the stamp taken before the kill. A read past
 * the script throws instead of repeating, since a reading that asks more often than the case
 * described is a different reading; `undefined` is a legitimate answer, so the bound is checked
 * before the take. Both suites take a scripted root.
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
