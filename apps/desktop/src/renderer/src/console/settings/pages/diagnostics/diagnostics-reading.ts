// The diagnostics page's reads: four questions, one refresh, four independent answers.
//
// `Spec-023 §Console Design (Meridian)` §Diagnostics and health names five operations
// and forbids the only streaming one: "Never polls. There is no health subscription,
// so the surface re-reads on focus, on reconnect, and on run-terminal events." Four of
// the five are reads and compose here; the fifth is the recovery request, which is a
// MUTATION a person presses and belongs beside the control that raises it rather than
// inside a refresh.
//
// WHY THE FOUR SETTLE INDEPENDENTLY
//
// "Refusals: rendered on the control that raised them, with the recovery prompt left
// available." A single `Promise.all` cannot do that — the first rejection would take
// the whole page down and a machine whose redaction policy is unreadable would look
// like a machine with no health at all. So each read is settled on its own and reaches
// the surface as its own two-armed answer, exactly as the mount inventory settles one
// mount at a time.
//
// WHICH SIGNALS REFRESH IT, AND WHY THERE IS NO FIFTH
//
//   • **Focus** — installed beside the read by the component that owns its lifetime.
//   • **Reconnect** — the console's one transport signal, off `ConsoleBridge`. A
//     window that never lost focus can still have read every one of these figures
//     across a gap in the wire.
//   • **Run-terminal events** — the three registered terminals, taken from the session
//     store this window already subscribes to. A run ending is the moment a stall
//     stops being a stall and a failure becomes readable, so it is the one session
//     fact that moves what this page says.
//
// There is deliberately no timer. `health.subscribe` exists in the corpus and is
// registered against a different slate row for a different surface; this page may not
// use it, and re-reading on an interval to make up for that would be the poll the
// section forbids by name.
//
// THE TWO RUN-ADDRESSED READS ARE NOT ALWAYS PUT. A window with no session open, or a
// session with no moving run and no failed one, has no run id to name — and a read
// that cannot be addressed is `unasked` rather than empty. The distinction is the
// whole point: "nothing was asked" and "the daemon says nothing is wrong" are
// different sentences and only one of them is reassuring.

import type { SessionEventType } from "@ai-sidekicks/contracts";

import {
  type ConsoleBridge,
  type GrowthFailureDetail,
  type GrowthHealthStatus,
  type GrowthOutcome,
  type GrowthRedactionPolicy,
  type GrowthStuckRunInspection,
} from "../../../bridge/index.js";
import { settleGrowthRead } from "../../../bridge/index.js";
import type { ConsoleClock, ConsoleRefusal, Unsubscribe } from "../../../core/index.js";
import { PushDrivenRead } from "../../../seats/index.js";
import { subscribeToSessionEventKinds, type SessionStore } from "../../../store/index.js";
import type { DiagnosticsRunSubjects } from "./stall/run-subjects.js";

/** Names this read in a refusal, so a failure says which read failed. */
export const DIAGNOSTICS_READ_ORIGIN = "diagnostics";

/**
 * The three registered terminals, and the whole of this page's session subscription.
 *
 * `run.queued` and the rest of the transitions are deliberately absent: a run starting
 * changes neither a stall reading nor a failure detail, and a subscription that woke on
 * every transition would re-read four wires through a run's whole lifetime for answers
 * that had not moved.
 *
 * Typed as the contract's own census member, so a kind this console invents fails to
 * compile rather than subscribing to a name the daemon never sends.
 */
const RUN_TERMINAL_EVENT_KINDS: readonly SessionEventType[] = [
  "run.completed",
  "run.failed",
  "run.interrupted",
];

/**
 * One read's answer. Three arms, because "not asked" is not "asked and told nothing".
 *
 * The refused arm carries the refuser's own refusal — the port's where the wire is
 * unregistered, the daemon's where it answered and declined — so rule 9's verbatim
 * code and sentence reach the region that raised them without being rebuilt.
 */
export type DiagnosticsArm<TValue> =
  | { readonly kind: "unasked"; readonly because: string }
  | { readonly kind: "served"; readonly value: TValue }
  | { readonly kind: "refused"; readonly refusal: ConsoleRefusal };

/** Everything one refresh of this page answers, plus when it answered. */
export interface DiagnosticsReading {
  readonly status: DiagnosticsArm<GrowthHealthStatus>;
  readonly stall: DiagnosticsArm<GrowthStuckRunInspection>;
  readonly failure: DiagnosticsArm<GrowthFailureDetail>;
  readonly policy: DiagnosticsArm<GrowthRedactionPolicy>;
  /**
   * The console clock's instant when this reading settled.
   *
   * Carried on the reading rather than read at render, so the quiet interval beside
   * the stall badge is measured once and never ticks — which is what keeps a
   * presentation threshold from becoming a poll.
   */
  readonly readAtMilliseconds: number;
  /** The run the stall question was put about, so the region can name it. */
  readonly stalledCandidateRunId: string | undefined;
  /** The run the failure question was put about, so the region can name it. */
  readonly failedCandidateRunId: string | undefined;
}

/** The read the diagnostics page is built on, with its refresh already bound. */
export type DiagnosticsRead = PushDrivenRead<DiagnosticsReading>;

export interface DiagnosticsReadOptions {
  readonly bridge: ConsoleBridge;
  readonly clock: ConsoleClock;
  readonly subjects: DiagnosticsRunSubjects;
  /**
   * The retained session's store, where this window has one open.
   *
   * `undefined` is a real answer rather than a defect — settings is reachable with no
   * session — and it costs this read its run-terminal signal and nothing else. Focus
   * and reconnect still refresh it, because neither is the session's.
   */
  readonly sessionStore: SessionStore | undefined;
}

/**
 * Build the diagnostics read.
 *
 * Constructed by whoever owns its lifetime — the read-out's mount effect, never a
 * render body — and disposed with that owner.
 */
export function createDiagnosticsRead(options: DiagnosticsReadOptions): DiagnosticsRead {
  const { bridge, clock, subjects, sessionStore } = options;
  return new PushDrivenRead<DiagnosticsReading>({
    clock,
    origin: DIAGNOSTICS_READ_ORIGIN,
    read: async () => await readDiagnostics(bridge, clock, subjects),
    // One re-read per burst, never one per event: the signal goes to the read's own
    // `RefreshScheduler`, so three runs ending together cost one pass over four wires
    // rather than three.
    subscribe:
      sessionStore === undefined
        ? noSessionStoreOpen
        : (onChangeSignal) =>
            subscribeToSessionEventKinds(sessionStore, RUN_TERMINAL_EVENT_KINDS, onChangeSignal),
  });
}

async function readDiagnostics(
  bridge: ConsoleBridge,
  clock: ConsoleClock,
  subjects: DiagnosticsRunSubjects,
): Promise<DiagnosticsReading> {
  const { stalledCandidateRunId, failedCandidateRunId } = subjects;
  // Put together rather than in sequence: they address different wires and none of
  // them is an input to another, so a page that awaited them one after the next would
  // pay four latencies to answer one question.
  const [status, policy, stall, failure] = await Promise.all([
    settleArm(bridge.growth.healthStatusRead({})),
    settleArm(bridge.growth.healthRedactionPolicyRead({})),
    stalledCandidateRunId === undefined
      ? unaskedStall()
      : settleArm(bridge.growth.healthStuckRunInspect({ runId: stalledCandidateRunId })),
    failedCandidateRunId === undefined
      ? unaskedFailure()
      : settleArm(bridge.growth.healthFailureDetailRead({ runId: failedCandidateRunId })),
  ]);
  return {
    status,
    policy,
    stall,
    failure,
    readAtMilliseconds: clock.now(),
    stalledCandidateRunId,
    failedCandidateRunId,
  };
}

/**
 * Settle one growth read into its arm.
 *
 * Through `settleGrowthRead` rather than a bare `await`, because the growth seam has a
 * settlement its outcome union has no arm for: a scenario or a live wire that REJECTS
 * is thrown verbatim, and a read that only awaited would leave this region reading
 * "still arriving" for the life of the window over an answer that had already come.
 */
async function settleArm<TValue>(
  read: Promise<GrowthOutcome<TValue>>,
): Promise<DiagnosticsArm<TValue>> {
  const settlement = await settleGrowthRead(read);
  return settlement.status === "served"
    ? { kind: "served", value: settlement.value }
    : { kind: "refused", refusal: settlement };
}

/** The stall arm for a window with no moving run to ask about. */
async function unaskedStall(): Promise<DiagnosticsArm<GrowthStuckRunInspection>> {
  return {
    kind: "unasked",
    because:
      "No run in the session this window has open is still moving, so there was nothing to inspect. Runs in sessions this window has not opened are not reachable from here.",
  };
}

/** The failure arm for a window with no failed run to ask about. */
async function unaskedFailure(): Promise<DiagnosticsArm<GrowthFailureDetail>> {
  return {
    kind: "unasked",
    because:
      "No run in the session this window has open has failed, so no failure detail was read. Runs in sessions this window has not opened are not reachable from here.",
  };
}

/**
 * The subscribe for a window with no session store open, named rather than inline.
 *
 * A function that opens nothing and returns an unsubscribe that closes nothing. It
 * exists so the honest fact has a name at the call site: there is no stream to bind
 * because this window has no store for the session, NOT because the console has no
 * signal for a run ending.
 */
function noSessionStoreOpen(): Unsubscribe {
  return () => undefined;
}

/**
 * The component name whose blocked reading is a projection rebuild in trouble.
 *
 * A registered scope name rather than a guess: `health.statusRead`'s own request
 * narrows on `daemon | control_plane | provider | replay`, so `replay` is the wire's
 * word for this axis and not a string this console picked out of a reply.
 */
const REPLAY_COMPONENT_NAME = "replay";

/**
 * Whether the node reports its replay component blocked.
 *
 * `Spec-023 §Console Design (Meridian)` §Diagnostics and health's degraded state: "a
 * projection-rebuild failure renders the surface read-only and says so." This is the
 * "says so" half, and it is deliberately ALL of what the console derives from it: the
 * notice is drawn and no control is withdrawn, because withdrawing one would be this
 * renderer deciding a request will be refused — which the same page's rules forbid,
 * and which the section's own refusal state contradicts by requiring the recovery
 * prompt to stay available.
 *
 * Pure over the arm, so a surface cannot get a different answer from the same reply.
 */
export function isProjectionRebuildBlocked(status: DiagnosticsArm<GrowthHealthStatus>): boolean {
  return (
    status.kind === "served" &&
    status.value.components.some(
      (component) => component.name === REPLAY_COMPONENT_NAME && component.state === "blocked",
    )
  );
}
