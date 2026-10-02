// Every value and dependency the repos views are drawn against.
//
// Split from `repos.tsx`: that module owns how each view is reached (what it is mounted into and
// what settled means), this one owns what it is drawn against: the bridge and store the views are
// handed, and the change set no wire produces. Every export is inert, so a tier wanting a
// different composition states a new mount instead of mutating one of these.
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
 * header note rather than `+0 −0` under a bare path; an image holds that claim and a DOM
 * assertion does not. Built per call so two tiers do not share one model.
 */
export function extendedHeaderChangeSet(): DiffModel {
  return buildDiffFixture(EXTENDED_HEADER_DIFF_SHAPE);
}
