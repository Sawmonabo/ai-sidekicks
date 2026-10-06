// Every value and dependency the repos views are drawn against: the bridge and store they are
// handed, and the change set no wire produces. `views.tsx` owns how each view is mounted. Every
// export is inert, so a tier wanting a different composition states a new mount.
import type { PlatformBridge } from "#renderer/services/platform/bridge.js";
import type { Clock } from "#renderer/lib/clock.js";
import type { ScenarioEngine } from "#renderer/services/daemon/engine.fixture.js";
import { buildDiffFixture } from "#test/helpers/diff/fixture/model.js";
import { EXTENDED_HEADER_DIFF_SHAPE } from "#test/helpers/diff/fixture/shapes.js";
import type { DiffModel } from "#renderer/features/repos/diff/model.js";
import { bridgeOnClock } from "#test/helpers/fixture/bridge.js";
import { SESSION_ID } from "#renderer/features/repos/mounts/repo-mounts.test-support.js";
import { SessionStore } from "#renderer/store/session/store.js";
import { COMPOSED_ENTITY_PROJECTORS } from "../projector-composition.js";

/**
 * A bridge, the engine playing it, the frozen clock its window runs on, and a store over the
 * repos scenario's session, opened with the fold a window composes.
 *
 * The fold is required: a store without projectors folds every event into no entity, and a mount
 * cannot tell that from an empty session.
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
 * `EXTENDED_HEADER_DIFF_SHAPE` includes a rename with no hunks, which the views must draw with its
 * header note rather than `+0 −0` under a bare path. Built per call so two mounts do not share
 * one model.
 */
export function extendedHeaderChangeSet(): DiffModel {
  return buildDiffFixture(EXTENDED_HEADER_DIFF_SHAPE);
}
