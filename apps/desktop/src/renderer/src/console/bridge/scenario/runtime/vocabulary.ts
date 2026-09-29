// A scenario: the script the fixture bridge plays, held as DATA.
//
// The fixture bridge serves scripted scenarios over async generators with a frozen
// clock, and that clock is the only one the renderer reads in fixture mode.
//
// A scenario is therefore DATA, not code: an ordered script of events with the
// millisecond each is due, plus canned replies for request/response calls. That
// matters for two reasons beyond tidiness — a data scenario can be asserted against
// (the screenshot tier pins a frame by advancing to an exact tick), and a scenario
// that cannot reach the network or the clock cannot accidentally become flaky.
//
// WHAT IS NOT HERE. The engine that plays one, which is `engine.ts`. The
// two were one file until the seam this package's module rules split on
// was drawn between them, and that seam is exactly this one — WHAT a scenario
// is, against HOW it is played. The split is load-bearing rather than tidy: a seat
// board, the scenario manifest, and the wire-truth predicate that holds every scenario
// to the wire's own truth all DESCRIBE scenarios and play none, so they stop here
// and never reach the engine's teardown rules or its held-reply queue.
//
// AND THE REPLY TABLE IS NOT HERE EITHER, for that same rule applied a second time:
// `reply.ts` owns how one request/response CALL settles — the three arms, the
// refusal shape, and what a computed reply is handed — which is a different question
// from who this scenario is about and what it plays, and the module that settles one
// reply and the walk that audits every one of them both stop there.

import type { UpdateState } from "@ai-sidekicks/contracts";

import type { ConsoleSessionEvent } from "@renderer/store/session/entities/entities.js";
import type { ScenarioReply } from "@renderer/services/daemon/scenario-reply.fixture.js";

/** One scripted event and the tick it is due at, measured from scenario start. */
export interface ScenarioBeat {
  readonly atMs: number;
  readonly event: ConsoleSessionEvent;
}

export interface ConsoleScenario {
  readonly id: string;
  /** Shown in the fixture picker. Short; a name, not a sentence. */
  readonly label: string;
  /** What this scenario is for, so a reader knows which to reach for. */
  readonly purpose: string;
  readonly sessionId: string;
  /** Users in join order — the hue allocator's input (rule 2). */
  readonly userIdsInJoinOrder: readonly string[];
  /**
   * Which of those users this window IS, where the scenario states one.
   *
   * OPTIONAL, and the optionality is the point: join order is who opened the session
   * and who followed, so reading its head as "me" is a fabrication — and a surface
   * handed a fabricated identity attributes rows to somebody who is not looking. A
   * scenario that does not say leaves this absent and the fixture refuses the
   * caller-identity read, which is the honest "not checked" answer.
   *
   * When present it must be one of `userIdsInJoinOrder`: an identity outside
   * that list is the caller of some other session, and every surface that resolves it
   * would look it up and find nothing. `scenario/wire-truth/wire-truth.ts` holds every
   * scenario to that, the substrate's own two included.
   */
  readonly callerUserId?: string;
  readonly beats: readonly ScenarioBeat[];
  readonly replies: readonly ScenarioReply[];
  /**
   * Whether this scenario's daemon refuses a resume position the console submits.
   *
   * A BOOLEAN AND NOT THE CURSOR ITSELF, because the cursor is already stated once —
   * a scenario's `session.read` reply carries the acknowledged position, the store
   * submits exactly that string on its next read, and a second copy of it here would
   * be one value in two places, silently unreachable the moment they drifted. So the
   * scenario declares the DISPOSITION and the fixture applies it to whatever position
   * arrives.
   *
   * It is a scenario member rather than a `replies` row because the reply table
   * answers a call with one fixed value, and this refuses one ARM of a call — a read
   * carrying a position — while the same call with no position is served in the same
   * scenario, which is what makes the console's recovery observable at all.
   *
   * OPTIONAL, and its absence means the ordinary thing: this daemon resolves what it
   * acknowledged. A scenario that scripts no acknowledged position submits nothing and
   * is unaffected either way.
   */
  readonly refusesSubmittedResumeCursor?: boolean;
  /**
   * What the shell's updater reports, where the scenario states one.
   *
   * OPTIONAL, and the default is the one the fixture answered before this member
   * existed: a bare `idle` carrying no last-check instant. That default is load-
   * bearing rather than incidental — `UpdateState`'s `idle` arm carries an optional
   * `lastCheckedAt`, and a fixture that supplied one on every scenario would make
   * the never-checked arm unreachable in the deck, which is the arm a fresh install
   * is actually in.
   *
   * The updater is a SHELL surface rather than a daemon one, so it is a scenario
   * member and not a `replies` row: the reply table is keyed by daemon method or
   * control-plane procedure name, and `update.getState` is neither.
   */
  readonly updaterState?: UpdateState;
  /** Wall-clock instant the frozen clock reports as "now" at tick zero. */
  readonly startedAtIso: string;
}
