// A scenario: the script the fixture bridge plays, held as DATA.
//
// `Spec-023 §Console Design (Meridian)` §The fixture bridge: "the fixture bridge
// serves scripted scenarios over async generators with a frozen clock … the fixture
// clock is the only clock the renderer reads in fixture mode."
//
// A scenario is therefore DATA, not code: an ordered script of events with the
// millisecond each is due, plus canned replies for request/response calls. That
// matters for two reasons beyond tidiness — a data scenario can be asserted against
// (the screenshot tier pins a frame by advancing to an exact tick), and a scenario
// that cannot reach the network or the clock cannot accidentally become flaky.
//
// WHAT IS NOT HERE. The engine that plays one, which is `scenario-engine.ts`. The
// two were one file until it grew past the ~400-line rule `apps/desktop/AGENTS.md`
// sets, and the seam that growth was crossing is exactly this one — WHAT a scenario
// is, against HOW it is played. The split is load-bearing rather than tidy: a seat
// board, the scenario manifest, and the architecture tier that holds every scenario
// to the wire's own truth all DESCRIBE scenarios and play none, so they stop here
// and never reach the engine's teardown rules or its held-reply queue.

import type { ConsoleSessionEvent } from "../store/index.js";
import type { WireErrorEnvelope } from "../../../../shared/wire-errors.js";

/** One scripted event and the tick it is due at, measured from scenario start. */
export interface ScenarioBeat {
  readonly atMs: number;
  readonly event: ConsoleSessionEvent;
}

/** What every canned reply carries, whichever way it settles. */
interface ScenarioReplyBase {
  /** The daemon method or control-plane procedure name, verbatim. */
  readonly call: string;
  /**
   * Simulated latency, so a loading state is reachable in the fixture.
   *
   * Measured in scenario time, which only the caller moves: the reply stays
   * pending until the engine has been advanced this far past the call. It bounds
   * BOTH arms — a refusal a real transport takes 400 ms to deliver is a loading
   * state before it is an error, and a fixture that refused instantly would let a
   * surface ship without ever rendering that half.
   */
  readonly afterMs?: number;
}

/** A canned reply that answers with a value. */
export interface ScenarioResolvingReply extends ScenarioReplyBase {
  readonly result: unknown;
  readonly refusal?: never;
}

/**
 * A canned reply that REFUSES, with the shape the wire refuses in.
 *
 * Without this arm no scenario could reach a refusal at all: the fixture's own
 * `FixtureBridgeError` names something the FIXTURE could not do, so every typed
 * daemon refusal a surface has to render — an artifact too large, an ingest at
 * capacity, a terminal permission denied, a control already held by someone else —
 * was unreachable, and the console's refusal renderings could only ever be driven
 * from the growth port's one typed absence.
 *
 * `WireErrorEnvelope` is `src/shared/wire-errors.ts`'s, not a second refusal
 * vocabulary minted here: that module is the console's one home for the wire's
 * `{code, message}` shape and for `normalizeWireRejection`, which is what every
 * renderer catch arm already turns a rejection into. A fixture refusing in any
 * other shape would train a surface against a value the live bridge never sends.
 */
export interface ScenarioRejectingReply extends ScenarioReplyBase {
  readonly refusal: WireErrorEnvelope;
  readonly result?: never;
}

/**
 * A canned reply for one request/response call the scenario expects.
 *
 * Exactly one of `result` / `refusal`, enforced by the `?: never` member on each
 * arm rather than by two independent optionals — the two-arm-union idiom the
 * corpus already uses for `AgentAttachRequest` in
 * `docs/architecture/contracts/api-payload-contracts.md`. Two optionals would
 * admit both at once (a reply that resolves AND refuses) and neither at all (a
 * reply that settles no way), which are the two shapes nothing can serve.
 */
export type ScenarioReply = ScenarioResolvingReply | ScenarioRejectingReply;

export interface ConsoleScenario {
  readonly id: string;
  /** Shown in the fixture picker. Short; a name, not a sentence. */
  readonly label: string;
  /** What this scenario is for, so a reader knows which to reach for. */
  readonly purpose: string;
  readonly sessionId: string;
  /** Participants in join order — the hue allocator's input (rule 2). */
  readonly participantIdsInJoinOrder: readonly string[];
  /**
   * Which of those participants this window IS, where the scenario states one.
   *
   * OPTIONAL, and the optionality is the point: join order is who opened the session
   * and who followed, on any machine, so reading its head as "me" is a fabrication —
   * and a surface handed a fabricated identity renders a role gate as though it had
   * been checked. A scenario that does not say leaves this absent and the fixture
   * refuses the caller-identity read, which is the honest "not checked" answer.
   *
   * When present it must be a member of `participantIdsInJoinOrder`: an identity
   * outside the roster is a viewer of some other session, and every surface that
   * resolves a role would look it up and find nothing. `scenarios/wire-truth.ts`
   * holds every scenario to that, the substrate's own two included.
   */
  readonly viewingParticipantId?: string;
  readonly beats: readonly ScenarioBeat[];
  readonly replies: readonly ScenarioReply[];
  /** Wall-clock instant the frozen clock reports as "now" at tick zero. */
  readonly startedAtIso: string;
}
