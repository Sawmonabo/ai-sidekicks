// The fixture bridge: a real platform bridge backed by a scripted scenario. The daemon half is
// `services/daemon/daemon.fixture.ts`; this assembles it with the host's other answers.
//
// Native calls refuse rather than pretend, so a view cannot ship a code path nobody ran against
// the real dialog. The `app` meta is fixed so a rendered view does not shift with the machine. The
// keyboard map is held in memory: the first read is empty and a write is read back, which is the
// Keyboard page's whole contract with main.

import type {
  KeyboardMap,
  KeyboardMapReading,
  Unsubscribe,
  UpdateState,
} from "@shared/preload-api.js";
import type { PlatformBridge } from "./platform-bridge.js";
import {
  FixtureBridgeError,
  refuseAbsentCapability,
} from "@renderer/services/daemon/refusal.fixture.js";
import { TransportReconnectSignal } from "@renderer/services/transport/transport-reconnect.js";
import { ScenarioEngine } from "@renderer/services/daemon/engine.fixture.js";
import { createFixtureDaemon } from "@renderer/services/daemon/daemon.fixture.js";
import type { Scenario } from "@fixtures/scenario.js";

/** Fixed `app` meta, so a rendered view does not move with the machine. */
export const FIXTURE_APP_META: PlatformBridge["app"] = {
  version: "0.0.0-fixture",
  platform: "darwin",
  arch: "arm64",
  locale: "en-US",
  // 16 GiB, the machine the screen's memory budgets were measured on.
  physicalMemoryBytes: 17_179_869_184,
};

/** Options for `createFixtureBridge`. */
export interface FixtureBridgeOptions {
  readonly scenario: Scenario;
}

/**
 * The fixture bridge and the engine playing its scenario. The engine is the fixture seam's,
 * not the bridge's: its frozen clock is the one the window runs on, and it is what a driver
 * advances.
 */
export interface FixtureBridge {
  readonly bridge: PlatformBridge;
  readonly scenarioEngine: ScenarioEngine;
}

/** Builds the fixture bridge for one scenario, with the engine that plays it. */
export function createFixtureBridge(options: FixtureBridgeOptions): FixtureBridge {
  const scenarioEngine = new ScenarioEngine({ scenario: options.scenario });
  const updaterState: UpdateState = options.scenario.updaterState ?? { status: "idle" };
  const fixtureDaemon = createFixtureDaemon(scenarioEngine);
  let keyboardMap: KeyboardMap = {};
  const bridge: PlatformBridge = {
    daemon: {
      call: fixtureDaemon.call,
      subscribe: fixtureDaemon.subscribe,
    },
    native: {
      showOpenDialog: () => refuseAbsentCapability("native.showOpenDialog"),
      openExternal: () => refuseAbsentCapability("native.openExternal"),
      copyToClipboard: async () => {
        // A no-op is safe: nothing reads the result back, and a refusal would make every "copy id"
        // affordance untestable.
      },
    },
    update: {
      // The scenario's declaration, or a bare `idle`. The default omits the optional
      // `lastCheckedAt` so the never-checked arm stays reachable.
      getState: async (): Promise<UpdateState> => updaterState,
      subscribe: (handler): Unsubscribe => {
        handler(updaterState);
        return () => undefined;
      },
      requestCheck: () => refuseAbsentCapability("update.requestCheck"),
      requestDownload: () => refuseAbsentCapability("update.requestDownload"),
      requestRestart: () => refuseAbsentCapability("update.requestRestart"),
    },
    machineSettings: {
      write: () => refuseAbsentCapability("machineSettings.write"),
      subscribe: () => refuseAbsentSubscription("machineSettings.subscribe"),
    },
    keyboardMap: {
      read: async (): Promise<KeyboardMapReading> => ({ map: keyboardMap }),
      write: async (map): Promise<KeyboardMap> => {
        keyboardMap = map;
        return map;
      },
    },
    app: FIXTURE_APP_META,
    transportReconnect: new TransportReconnectSignal(),
    source: "fixture",
  };
  return { bridge, scenarioEngine };
}

/**
 * Refuses, by throwing, a member main answers synchronously and the fixture cannot stand in for (a
 * subscription main pushes, or a publication main receives). It throws because the signature
 * returns before anything could settle.
 */
function refuseAbsentSubscription(call: string): never {
  throw new FixtureBridgeError(
    call,
    "capability-absent",
    "this capability needs the real main process and has no fixture stand-in",
  );
}
