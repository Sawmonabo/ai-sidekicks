// A scenario: the script the fixture bridge plays, held as data.
//
// An ordered script of events with the millisecond each is due, plus canned replies for
// request/response calls. Being data, it can be asserted against (a tier pins a frame by
// advancing to an exact tick) and cannot reach the network or the clock.
//
// `services/daemon/engine.fixture.ts` plays a scenario, and
// `services/daemon/scenario/scenario-reply.fixture.ts` owns how one reply settles.

import type { ProjectedSessionEvent } from "#renderer/store/session/entities/entities.js";
import type {
  ScenarioOpeningNotice,
  ScenarioReply,
} from "#renderer/services/daemon/scenario/scenario-reply.fixture.js";

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
  readonly beats: readonly ScenarioBeat[];
  readonly replies: readonly ScenarioReply[];
  /** The frames machine streams open with, where the daemon sends one first. */
  readonly openingNotices?: readonly ScenarioOpeningNotice[];
  /** Wall-clock instant the frozen clock reports as "now" at tick zero. */
  readonly startedAtIso: string;
}
