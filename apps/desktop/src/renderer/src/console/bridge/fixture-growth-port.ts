// The growth port the fixture bridge actually serves.
//
// Every other growth operation refuses under both bridges, which is what makes the
// "not checked" absence a true statement rather than a placeholder. Two do not, and
// they are the two the console cannot function without: a session snapshot read and
// a session directory read.
//
// WHY THESE TWO ARE SERVED AND THE REST ARE NOT
//
// A `SessionStore` admits nothing until a read gives it a base state. With no read
// registered anywhere, every store this renderer opens buffers its stream and
// projects none of it — so the window binds no stream at all, the store layer is
// dormant in every build, and the endurance tier measures an idle console. The
// directory read is the same shape one level up: without it the only session set a
// surface can name is the set this window happens to have open, so a fresh window
// shows "nothing" for a node with sessions on it.
//
// Serving them here — from the scenario, under the fixture define — is what lets
// the whole store layer run against a scripted session while the wire is still
// unregistered. The live bridge keeps refusing both, so nothing about what a
// release build renders changes.
//
// WHY THE SNAPSHOT IS NOT `SessionReadResponse` FROM `@ai-sidekicks/contracts`
//
// It is the registered reply and it is the wrong shape for this seam, on two
// counts that both matter. It carries no console-orderable cursor, no entities and
// no join log — the three things `SessionStore.initialise` needs — so adopting it
// would leave the adapter fabricating all three anyway. And `SessionId` is a
// UUID-branded scalar while a scenario's session ids are scripted names, so the
// fixture could not produce a schema-valid value without a cast that switches off
// exactly the checking the reuse was for. The port's value is therefore the
// console's own `SessionSnapshot`, which mints no second shape, and the slate row
// names the registered request and reply as the half the corpus already owns.
//
// WHAT THE BASE STATE HONESTLY IS
//
// Cursor zero, no entities, and the scenario's join log. Zero rather than a
// position derived from the scenario's beats, because a base state ahead of the
// stream would make the store discard every beat below it; the subscription is
// replay-then-tail, so nothing is missed by starting at the bottom. A re-read
// therefore lands behind an initialised store's cursor and is a silent no-op,
// which is `SessionStore.admitsSnapshotAt`'s documented behaviour and not a defect
// of this port: repairing a degraded store needs a read that carries a position,
// and this one cannot until the wire does.

import {
  createRefusingGrowthPort,
  type GrowthPort,
  type GrowthSessionSummary,
} from "./growth-port.js";
import type { ScenarioEngine } from "./scenario.js";

/**
 * The operations the fixture answers rather than refuses.
 *
 * A tuple, so the served set is declared once: `scenario-manifest.ts` ledgers it,
 * `fixture-bridge.ts` publishes it as the bridge's served set, and the `Pick`
 * below makes a member with no implementation — or an implementation with no
 * member — a compile error rather than a runtime surprise.
 */
export const FIXTURE_SERVED_GROWTH_OPERATION_IDS = ["sessionRead", "sessionList"] as const;

/** One operation the fixture serves. Derived, so the set has exactly one home. */
export type FixtureServedGrowthOperationId = (typeof FIXTURE_SERVED_GROWTH_OPERATION_IDS)[number];

/**
 * Build the fixture's growth port for one running scenario.
 *
 * Starts from the refusing port so an operation added to the ledger and not to the
 * served set refuses by name instead of being absent — the port's shape is checked
 * against `GROWTH_OPERATIONS` by `failure-modes.test.ts`, and a spread that dropped
 * a method would fail that check rather than silently render `undefined is not a
 * function` in a surface.
 */
export function createFixtureGrowthPort(engine: ScenarioEngine): GrowthPort {
  const served: Pick<GrowthPort, FixtureServedGrowthOperationId> = {
    sessionRead: async (request) => ({
      status: "served",
      value: {
        cursor: 0,
        entities: [],
        // The join log is the scenario's only where the scenario is the session
        // being read. Another id gets an empty one rather than this session's
        // roster: hue allocation keys on join order, and lending one session's
        // order to another would colour a stranger's rows as if they were hers.
        participantJoinLog:
          request.sessionId === engine.scenario.sessionId
            ? engine.scenario.participantIdsInJoinOrder
            : [],
      },
    }),
    sessionList: async () => ({
      status: "served",
      value: [
        {
          sessionId: engine.scenario.sessionId,
          // A scenario plays one live session, so `active` is a reading rather
          // than a guess. No title: a scenario declares none as a field, and
          // lifting one out of a beat's payload would have the fixture inventing
          // a wire fact for the one surface that renders it.
          state: "active",
        } satisfies GrowthSessionSummary,
      ],
    }),
  };
  return { ...createRefusingGrowthPort(), ...served };
}
