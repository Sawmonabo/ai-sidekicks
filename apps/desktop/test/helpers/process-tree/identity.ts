// A pid is a NAME, and this is the module that refuses to treat it as a process.
//
// The operating system takes a pid back and hands it out again, so every reading
// in `liveness.ts` can be taken of a number that no longer belongs to the tree it
// was recorded for — the launcher shim exits early and is reaped, which makes
// that window ordinary here rather than exotic. What closes it is a per-instance
// start stamp: captured while the process is certainly the one meant, re-read
// before anything is signalled, and compared.
//
// TWO THINGS CARRY AN IDENTITY, AND FOR DIFFERENT REASONS
//
//   • THE ROOT, because it is the number a tree is addressed THROUGH.
//     `terminateExternalTree` walks a tree DOWN from its root pid, and a walk
//     from a reissued number terminates a stranger, exits zero, and latches
//     `ManagedElectronChild` as killed while this package's browser keeps
//     running.
//   • EACH DESCENDANT, because they are the only handle that survives the root.
//     Once the root pid is gone or reissued, the captured set is what a rootless
//     tree is addressed by — and a captured pid is a number like any other, so a
//     capture without a stamp hands the arm a stranger to kill one indirection
//     along. That is the same defect as signalling the root, and it is why
//     `CapturedTreeMember` is a pair rather than a pid.
//
// WHAT AN UNREADABLE STAMP MEANS, ONCE, FOR BOTH
//
// Nothing. A pair that cannot be compared — no capture, or no current reading —
// is admitted rather than refused, at the root and at every descendant alike.
// That is a deliberate degradation: refusing every kill on a host whose stamp
// probe does not work would leak every tree on that host, which is a larger
// failure than the one this module closes, and detection there is impossible by
// construction rather than by choice. A pid is convicted only by a stamp that
// DISAGREES, never by a stamp that is missing.

import { processExists } from "./liveness.js";
import {
  descendantsOf,
  readProcessStartStamp,
  readProcessTable,
  type ProcessStartStampReader,
  type ProcessTableReader,
  type ProcessTableRow,
} from "./readers.js";

/**
 * Whether the pid a tree is addressed THROUGH still names that tree's root.
 *
 * Three answers rather than two, because "not ours" splits into two facts that
 * owe different behaviour — `arms.ts` has the mechanism. `gone` means the root
 * exited and its number names nothing; `recycled` means the number names an
 * unrelated process, so neither it nor anything reached through it is this
 * tree's.
 */
export type TreeRootIdentity = "same" | "gone" | "recycled";

/**
 * One descendant, captured while the tree was verifiably this one's.
 *
 * The pid is what a kill is addressed to and the stamp is what says the address
 * is still the right one. `startStamp` is `undefined` when the listing carried
 * none, which admits the member rather than refusing it — the module header
 * states that failure direction once for the root and for these.
 */
export interface CapturedTreeMember {
  /** The pid this member held when it was captured. */
  readonly processId: number;
  /** Its per-instance start stamp then, or `undefined` if none was read. */
  readonly startStamp: string | undefined;
}

/**
 * The captured members whose pid still names the process it was captured from.
 *
 * REFUSAL IS ON DISAGREEMENT AND NEVER ON ABSENCE, which is the whole rule and
 * the reason this is one named function rather than a filter at each arm:
 *
 *   • Both stamps read and they DIFFER — the pid was reissued between the
 *     capture and now, so it names a stranger and is dropped. Killing it is the
 *     defect this exists to prevent.
 *   • Either stamp is missing — no comparison was possible, so the member is
 *     kept. A row absent from the table is the ordinary shape for a descendant
 *     that has already exited, and such a member is filtered by the caller's own
 *     liveness reading before anything is signalled; an EMPTY table is an
 *     unreadable listing, and reading it as "everything has exited" would disarm
 *     the rootless arm on exactly the host whose readings do not work.
 *   • Both stamps read and they AGREE — the member is still itself.
 */
export function verifyCapturedMembers(
  captured: readonly CapturedTreeMember[],
  processTable: ReadonlyMap<number, ProcessTableRow>,
): number[] {
  return captured
    .filter((member) => {
      const currentStamp = processTable.get(member.processId)?.startStamp;
      return (
        member.startStamp === undefined ||
        currentStamp === undefined ||
        currentStamp === member.startStamp
      );
    })
    .map((member) => member.processId);
}

/**
 * A spawned tree's root, captured while it is certainly still that root.
 *
 * THE HANDLE A PID IS NOT. `terminateExternalTree` walks a tree DOWN from its
 * root pid, and by the time a disposal runs that pid may name an unrelated
 * process — the shim exits early and is reaped, which is the ordinary shape here
 * and not a corner of one. Signalling it terminates a stranger, the platform
 * exits zero, and `ManagedElectronChild` latches on the zero while the browser
 * this package spawned keeps running. So the tree carries an identity from the
 * moment it is spawned, and every later signal re-reads it first.
 *
 * The descendant capture is the second half and cannot be taken at spawn: an
 * Electron has no children in the instant it starts. It is refreshed on every
 * VERIFIED reading instead, so the last set taken while the root was demonstrably
 * this tree's is the set still nameable once the pid stops being. Refreshed only
 * on the verified arm, because a capture taken under an unverifiable identity is
 * a capture nothing can ever consume — the reissued-root reading it exists for is
 * exactly the reading that arm cannot reach. Each member is captured WITH the
 * stamp the same listing reported for it, so the set stays addressable after the
 * root is gone without becoming a list of numbers nothing has verified.
 *
 * Every collaborator is injected for this package's usual reason and one
 * stronger: a pid whose holder changes between two reads is not a state a test
 * can arrange against a live process, and it is the only state this class is
 * about.
 */
export class SpawnedTreeIdentity {
  readonly #processId: number;
  readonly #readStamp: ProcessStartStampReader;
  readonly #readProcessTable: ProcessTableReader;
  readonly #rootExists: (processId: number) => boolean;
  readonly #capturedStamp: string | undefined;
  #capturedDescendants: readonly CapturedTreeMember[] = [];

  constructor(
    processId: number,
    readStamp: ProcessStartStampReader = readProcessStartStamp,
    readTable: ProcessTableReader = readProcessTable,
    rootExists: (processId: number) => boolean = processExists,
  ) {
    this.#processId = processId;
    this.#readStamp = readStamp;
    this.#readProcessTable = readTable;
    this.#rootExists = rootExists;
    this.#capturedStamp = readStamp(processId);
  }

  /**
   * A tree whose root was never captured, for a caller that holds no spawn moment.
   *
   * Named rather than defaulted silently, because what it gives up is exactly
   * what this class exists for: with nothing to compare against, a reissued pid
   * is undetectable and the reading degrades to the one this module took before
   * identity existed — `same` while the pid names anything. The one caller is
   * `terminateProcessTree`'s default, reached from `BoundedCleanup`, which is
   * handed a pid by Playwright rather than by a spawn of its own and so has no
   * moment at which the capture would mean anything.
   *
   * It captures no descendants either, and the consequence is named rather than
   * hidden: once such a root is GONE there is nothing this package may address,
   * because the only remaining evidence is a parent table whose rows under a dead
   * pid cannot be told from a stranger's. That arm therefore reports whatever the
   * table says still claims the number, and kills none of it.
   */
  static unverified(processId: number): SpawnedTreeIdentity {
    return new SpawnedTreeIdentity(processId, () => undefined);
  }

  /** The members captured while the root last read `same`, each with its stamp. */
  get capturedDescendants(): readonly CapturedTreeMember[] {
    return this.#capturedDescendants;
  }

  /**
   * What the root pid names right now, and a refreshed capture when it is ours.
   *
   * Existence decides `gone` rather than the stamp, and the order is the claim:
   * a stamp that could not be read on a LIVE process is an unreadable probe, and
   * reading that as `gone` would skip the one walk that reaches the tree. So the
   * pid is asked whether it names anything first, and the stamp is asked only to
   * separate ours from somebody else's.
   *
   * An unverifiable pair — no capture, or no current reading — answers `same`,
   * for the reason the module header gives once for every stamp comparison here.
   */
  readIdentity(): TreeRootIdentity {
    if (this.#processId <= 0 || !this.#rootExists(this.#processId)) {
      return "gone";
    }
    const currentStamp = this.#readStamp(this.#processId);
    if (this.#capturedStamp === undefined || currentStamp === undefined) {
      return "same";
    }
    if (currentStamp !== this.#capturedStamp) {
      return "recycled";
    }
    const processTable = this.#readProcessTable();
    this.#capturedDescendants = descendantsOf(this.#processId, processTable).map(
      (descendantProcessId) => ({
        processId: descendantProcessId,
        startStamp: processTable.get(descendantProcessId)?.startStamp,
      }),
    );
    return "same";
  }
}
