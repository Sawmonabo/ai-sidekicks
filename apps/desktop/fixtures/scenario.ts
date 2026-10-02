// A scenario: the script the fixture bridge plays, held as data.
//
// An ordered script of events with the millisecond each is due, plus canned replies for
// request/response calls. Being data, it can be asserted against (the screenshot tier pins
// a frame by advancing to an exact tick) and cannot reach the network or the clock.
//
// `services/daemon/engine.fixture.ts` plays a scenario, and
// `services/daemon/scenario-reply.fixture.ts` owns how one reply settles.

import type { UpdateState } from "@shared/preload-api.js";

import type { ProjectedSessionEvent } from "@renderer/store/session/entities/entities.js";
import type { ScenarioReply } from "@renderer/services/daemon/scenario-reply.fixture.js";

/** One scripted event and the tick it is due at, measured from scenario start. */
export interface ScenarioBeat {
  readonly atMs: number;
  readonly event: ProjectedSessionEvent;
}

/** A scripted session: the beats it plays and the replies it answers with. */
export interface Scenario {
  readonly id: string;
  /** A short name, not a sentence. */
  readonly label: string;
  /** What this scenario is for, so a reader knows which to reach for. */
  readonly purpose: string;
  readonly sessionId: string;
  /** Which of the session's users this window is, when the scenario states one. */
  readonly thisDeviceId?: string;
  readonly beats: readonly ScenarioBeat[];
  readonly replies: readonly ScenarioReply[];
  /**
   * Whether this scenario's daemon refuses a resume position the console submits.
   *
   * A flag rather than the cursor, which the scenario's `session.read` reply already
   * carries. It is not a `replies` row because a row answers a call with one fixed value,
   * while this refuses only the read that carries a position and serves the same call
   * without one, so the console's recovery is observable. Absent means the daemon resolves
   * what it acknowledged.
   */
  readonly refusesSubmittedResumeCursor?: boolean;
  /**
   * What the main process's updater reports, when the scenario states one.
   *
   * The default is a bare `idle` with no `lastCheckedAt`, the state of a fresh install. It
   * is a scenario member rather than a `replies` row because the reply table is keyed by
   * daemon method or control-plane procedure name, and `update.getState` is neither.
   */
  readonly updaterState?: UpdateState;
  /** Wall-clock instant the frozen clock reports as "now" at tick zero. */
  readonly startedAtIso: string;
}
