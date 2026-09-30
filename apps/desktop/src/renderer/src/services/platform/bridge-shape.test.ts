// The fixture bridge answers the preload's operations and no others. The type catches a missing
// member, but not an extra one reaching a namespace through a spread or a held object, so both
// real bridges are read at runtime and compared: the live one from the stub bridge the preload
// spreads its handlers over, the fixture one by its own factory.

import { describe, expect, it } from "vitest";

import { createStubBridge } from "@shared/preload-api.js";
import { findScenario } from "../../../../../fixtures/index.js";
import { FIRST_RUN_SCENARIO_ID } from "../../../../../fixtures/scenarios/first-run.js";
import {
  DESKTOP_BRIDGE_NAMESPACES,
  describeBridgeShape,
  diffBridgeShapes,
} from "./bridge-shape.js";
import { createLiveBridge } from "./live-bridge.js";
import { FIXTURE_APP_META, createFixtureBridge } from "./platform-bridge.fixture.js";

describe("the fixture bridge", () => {
  it("has the live bridge's namespaces and the same members in each", () => {
    const live = describeBridgeShape(createLiveBridge(createStubBridge(FIXTURE_APP_META)));
    const fixture = describeBridgeShape(
      createFixtureBridge({ scenario: findScenario(FIRST_RUN_SCENARIO_ID) }).bridge,
    );

    // Not vacuous: every namespace the contract declares was read, each with members.
    expect([...live.keys()].sort()).toStrictEqual([...DESKTOP_BRIDGE_NAMESPACES].sort());
    for (const namespace of DESKTOP_BRIDGE_NAMESPACES) {
      expect(live.get(namespace)?.length ?? 0).toBeGreaterThan(0);
    }
    expect(
      diffBridgeShapes(
        { label: "the live bridge", shape: live },
        { label: "the fixture bridge", shape: fixture },
      ),
    ).toStrictEqual([]);
  });
});
