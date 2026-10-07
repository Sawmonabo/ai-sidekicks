// The synthetic logs the window-cap suites run over, and the conditions a prune is asked under.
// Shared so the two suites cannot drift on what the window is shown. Ten thousand rows because
// the properties that matter (children never trip the cap, a closure never orphans, a held row
// survives however old) are invisible at a hundred. `RandomLogChanges` plays a seeded sequence
// of the changes a projection makes between two reconciles, for the ingest equivalence check.

import { TranscriptWindow, type PruneConditions } from "./window-cap.js";
import type { WindowRow } from "./window-cap.js";

/**
 * A seeded sequence of logs, each one change away from the last, keeping row objects across
 * steps the way the projection's retention does. A parent key is always older than its child's,
 * so no change can build a cycle the ancestor closure would walk forever.
 */
export class RandomLogChanges {
  readonly #random: () => number;
  /** Runs whose rows name them as parent while no row is the run itself yet. */
  readonly #openRunKeys: string[] = [];

  #log: readonly WindowRow[] = [];
  #createdRowCount = 0;
  #createdRunCount = 0;

  public constructor(seed: number) {
    this.#random = createSeededRandom(seed);
  }

  /** Make one change, chosen at random, and return the log it leaves. */
  public next(): LogChangeStep {
    const change: LogChange =
      this.#log.length > MAXIMUM_LOG_LENGTH ? "trim-head" : this.#pick(LOG_CHANGES);
    this.#log = this.#apply(change);
    return { change, log: this.#log };
  }

  #apply(change: LogChange): readonly WindowRow[] {
    const log = this.#log;
    switch (change) {
      case "append":
        return [...log, ...this.#createRows(1 + this.#integerBelow(3), "top-level")];
      case "append-child":
        return [...log, ...this.#createRows(1, "child")];
      case "append-orphan":
        return [...log, ...this.#createRows(1, "orphan")];
      case "prepend":
        return [...this.#createRows(1 + this.#integerBelow(4), "mixed"), ...log];
      case "trim-head":
        return log.slice(1 + this.#integerBelow(5));
      case "insert-middle": {
        const position = this.#integerBelow(log.length + 1);
        const inserted = this.#createRows(1 + this.#integerBelow(3), "mixed");
        return [...log.slice(0, position), ...inserted, ...log.slice(position)];
      }
      case "remove-middle": {
        const position = this.#integerBelow(log.length + 1);
        return [...log.slice(0, position), ...log.slice(position + 1 + this.#integerBelow(4))];
      }
      case "fold-run":
        return this.#foldRun();
      case "reparent":
        return this.#replaceOneRow((row) => ({
          ...row,
          parentKey: row.parentKey === undefined ? this.#olderParentKeyFor(row.key) : undefined,
        }));
      case "recreate":
        return this.#replaceOneRow((row) => ({ ...row }));
      case "repeat-key": {
        const repeated = log[this.#integerBelow(log.length)];
        if (repeated === undefined) {
          return [...log];
        }
        const position = this.#integerBelow(log.length + 1);
        const copy = this.#random() < 0.5 ? repeated : { ...repeated };
        return [...log.slice(0, position), copy, ...log.slice(position)];
      }
      case "drop-repeats": {
        const seenKeys = new Set<string>();
        return log.filter((row) => {
          const isFirst = !seenKeys.has(row.key);
          seenKeys.add(row.key);
          return isFirst;
        });
      }
      case "same-log":
        return this.#random() < 0.5 ? log : [...log];
      case "replace-all":
        this.#openRunKeys.length = 0;
        return this.#createRows(5 + this.#integerBelow(25), "mixed");
    }
  }

  /** A run's rows collapse into its header row and the receipt hanging from it, where it began. */
  #foldRun(): readonly WindowRow[] {
    const runKey = this.#openRunKeys.find((openRunKey) =>
      this.#log.some((row) => row.parentKey === openRunKey),
    );
    if (runKey === undefined) {
      return [...this.#log];
    }
    this.#openRunKeys.splice(this.#openRunKeys.indexOf(runKey), 1);
    const runRows = this.#log.filter((row) => row.parentKey === runKey);
    const receipt = runRows[runRows.length - 1];
    const header: WindowRow = { key: runKey, parentKey: undefined, rootCursor: runKey };
    const folded: WindowRow[] = [];
    for (const row of this.#log) {
      if (row.parentKey !== runKey) {
        folded.push(row);
      } else if (row === runRows[0]) {
        folded.push(header);
        if (receipt !== undefined) {
          folded.push({ ...receipt });
        }
      }
    }
    return folded;
  }

  #replaceOneRow(replace: (row: WindowRow) => WindowRow): readonly WindowRow[] {
    const position = this.#integerBelow(this.#log.length);
    return this.#log.map((row, index) => (index === position ? replace(row) : row));
  }

  #createRows(count: number, placement: RowPlacement | "mixed"): WindowRow[] {
    return Array.from({ length: count }, () => {
      this.#createdRowCount += 1;
      const key = `row-${String(this.#createdRowCount)}`;
      const chosen = placement === "mixed" ? this.#pick(ROW_PLACEMENTS) : placement;
      const parentKey =
        chosen === "top-level"
          ? undefined
          : chosen === "child"
            ? this.#olderParentKeyFor(key)
            : this.#openRunKey();
      return { key, parentKey, rootCursor: key };
    });
  }

  /** A key of a row older than `rowKey` still in the log, or `undefined` when there is none. */
  #olderParentKeyFor(rowKey: string): string | undefined {
    const candidates = this.#log.filter((row) => rowNumberOf(row.key) < rowNumberOf(rowKey));
    return candidates[this.#integerBelow(candidates.length)]?.key;
  }

  #openRunKey(): string {
    const existing = this.#openRunKeys[this.#integerBelow(this.#openRunKeys.length + 1)];
    if (existing !== undefined) {
      return existing;
    }
    this.#createdRunCount += 1;
    const runKey = `run-${String(this.#createdRunCount)}`;
    this.#openRunKeys.push(runKey);
    return runKey;
  }

  #pick<Choice>(choices: readonly Choice[]): Choice {
    const choice = choices[this.#integerBelow(choices.length)];
    if (choice === undefined) {
      throw new Error("picked from no choices");
    }
    return choice;
  }

  #integerBelow(bound: number): number {
    return Math.floor(this.#random() * bound);
  }
}

/** Top-level rows in the log {@link loadedWindow} is built over. */
export const TOP_LEVEL_ROW_COUNT = 10_000;

/** Children hanging from each run group in that log. */
export const CHILDREN_PER_RUN_GROUP = 3;

/** A log of run groups, each with children, oldest first. */
export function syntheticWindowRows(topLevelCount: number): readonly WindowRow[] {
  const rows: WindowRow[] = [];
  for (let index = 0; index < topLevelCount; index += 1) {
    const key = `run-group-${String(index)}`;
    rows.push({ key, parentKey: undefined, rootCursor: `cursor-${String(index)}` });
    for (let child = 0; child < CHILDREN_PER_RUN_GROUP; child += 1) {
      rows.push({
        key: `${key}-child-${String(child)}`,
        parentKey: key,
        rootCursor: `cursor-${String(index)}`,
      });
    }
  }
  return rows;
}

/**
 * A log of folded run groups as the transcript emits one: a header row keyed by the run, and the
 * terminal receipt hanging from it, the shape `foldRunGroupHeaders` produces. It lives here
 * because it exercises the cap's counting rule.
 */
export function foldedRunGroupLog(runGroupCount: number): readonly WindowRow[] {
  const rows: WindowRow[] = [];
  for (let index = 0; index < runGroupCount; index += 1) {
    const runKey = `run-${String(index)}`;
    rows.push({ key: runKey, parentKey: undefined, rootCursor: runKey });
    rows.push({
      key: `${runKey}-receipt`,
      parentKey: runKey,
      rootCursor: `cursor-${String(index)}`,
    });
  }
  return rows;
}

/** A log whose every row names one run, and where no row IS that run. */
export function runOnlyLog(entryCount: number): readonly WindowRow[] {
  return Array.from({ length: entryCount }, (_unused, index) => ({
    key: `run-1-entry-${String(index)}`,
    parentKey: "run-1",
    rootCursor: `cursor-${String(index)}`,
  }));
}

/** Conditions under which nothing refuses a prune: the all-clear. */
export const PRUNABLE: PruneConditions = {
  hasActiveTurn: false,
  scrollControllerVetoes: false,
  revealDrainInFlight: false,
  pinnedRootCursor: undefined,
  heldRowKeys: [],
  readingFloorRowKey: undefined,
};

/** A window holding the whole synthetic log, well over its own cap. */
export function loadedWindow(): TranscriptWindow {
  const window = new TranscriptWindow();
  window.ingest(syntheticWindowRows(TOP_LEVEL_ROW_COUNT));
  return window;
}

/**
 * Every change `RandomLogChanges` can make: growth and trimming at either end and in the middle,
 * a run folding into its header, a row moving parent or coming back as a fresh object, a repeated
 * key appearing and clearing, the same log again, and a log replaced whole.
 */
const LOG_CHANGES = [
  "append",
  "append-child",
  "append-orphan",
  "prepend",
  "trim-head",
  "insert-middle",
  "remove-middle",
  "fold-run",
  "reparent",
  "recreate",
  "repeat-key",
  "drop-repeats",
  "same-log",
  "replace-all",
] as const;

/** One change a projection makes to the log between two reconciles. */
type LogChange = (typeof LOG_CHANGES)[number];

/** One step of a `RandomLogChanges` sequence: what changed and the log it produced. */
interface LogChangeStep {
  readonly change: LogChange;
  /** Never mutated once returned, since the window holds the array it ingests. */
  readonly log: readonly WindowRow[];
}

/** Where a created row hangs: from nothing, from an older row in the log, or from an open run. */
const ROW_PLACEMENTS = ["top-level", "child", "orphan"] as const;

/** One of `ROW_PLACEMENTS`. */
type RowPlacement = (typeof ROW_PLACEMENTS)[number];

/** Past this many rows the next change trims the head, so a sequence stays small enough to read. */
const MAXIMUM_LOG_LENGTH = 80;

/** A seeded source of numbers in [0, 1), so a failing sequence replays from its seed alone. */
function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/**
 * The creation order behind a key: `row-N` is the Nth row created, and a run key ranks older than
 * every row, so a run's header can parent any row and never hang from one.
 */
function rowNumberOf(rowKey: string): number {
  return rowKey.startsWith("row-") ? Number(rowKey.slice("row-".length)) : Number.NEGATIVE_INFINITY;
}
