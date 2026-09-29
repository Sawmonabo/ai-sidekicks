// Every value and collaborator the repos views are drawn against.
//
// SPLIT FROM `repos.tsx` ON THE SEAM BETWEEN WHAT AND HOW: that module owns HOW each
// view is reached — what it is mounted into and what settled means for it — and this
// one owns WHAT it is drawn against: the bridge and store the views are handed, and
// the change set no wire produces.
//
// NOTHING HERE RENDERS AND NOTHING HERE WAITS. Every export is inert, so a tier that
// wants a different composition states a new mount rather than reaching in and mutating
// one of these.
import type { PlatformBridge } from "@renderer/services/platform/platform-bridge.js";
import type { Clock } from "@renderer/lib/clock.js";
import type { ScenarioEngine } from "@renderer/services/daemon/engine.fixture.js";
import { buildDiffFixture } from "../diff-fixture.js";
import { EXTENDED_HEADER_DIFF_SHAPE } from "../diff-fixture-shapes.js";
import type { DiffModel } from "@renderer/features/repos/diff/diff-model.js";
import { bridgeOnClock } from "@test/helpers/fixture-bridge.js";
import { SESSION_ID } from "@renderer/features/repos/mounts/repo-mounts.test-support.js";
import { SessionStore } from "@renderer/store/session/session-store.js";
import { COMPOSED_ENTITY_PROJECTORS } from "./projector-composition.js";

/**
 * A bridge, the engine playing it, the frozen clock its window runs on, and a store over the
 * repos scenario's session, opened with the fold a window composes.
 *
 * The fold is not optional. A store built without projectors folds every event into no
 * entity, so a partition a view reads answers the empty map an empty session answers,
 * and a mount cannot tell the two apart.
 */
export function scenarioBridgeAndStore(): {
  bridge: PlatformBridge;
  scenarioEngine: ScenarioEngine;
  clock: Clock;
  sessionStore: SessionStore;
} {
  return {
    ...bridgeOnClock("repos"),
    sessionStore: new SessionStore({
      sessionId: SESSION_ID,
      projectors: COMPOSED_ENTITY_PROJECTORS,
    }),
  };
}

/**
 * The change set the diff pane is drawn over, on the shape carrying a header-only file.
 *
 * `EXTENDED_HEADER_DIFF_SHAPE` rather than the small one, so the set includes a file
 * whose whole change is in the patch's headers: a rename with no hunks, which the two
 * views drew as `+0 −0` under a bare path until the parser carried what the headers
 * said. What that note looks like beside a path and inside a file-header row is a claim
 * an image holds and a DOM assertion does not.
 *
 * Built per call rather than shared, because a model two tiers hold one copy of would
 * make the second tier's mount depend on whether the first had run.
 */
export function extendedHeaderChangeSet(): DiffModel {
  return buildDiffFixture(EXTENDED_HEADER_DIFF_SHAPE);
}
