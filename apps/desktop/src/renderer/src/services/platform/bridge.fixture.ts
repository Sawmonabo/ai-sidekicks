// The fixture bridge: a real platform bridge backed by a scripted scenario. The daemon half is
// `services/daemon/scenario/wire.fixture.ts`; this assembles it with the host's other answers.
//
// Native calls refuse rather than pretend, so a view cannot ship a code path nobody ran against
// the real dialog. The `app` meta is fixed so a rendered view does not shift with the machine. The
// keyboard map is held in memory: the first read is empty and a write is read back, which is the
// Keyboard page's whole contract with main. The appearance record is held the same way: the default
// appearance at first, and a chosen one reaches every subscriber, as main carries it to every
// window.

import { DEFAULT_APPEARANCE_RECORD, type AppearanceRecord } from "#shared/appearance.js";
import { consoleWindowId } from "#shared/window/frame-name.js";
import type {
  KeyboardMap,
  KeyboardMapReading,
  Unsubscribe,
  UpdateState,
} from "#shared/preload-api.js";
import type { PlatformBridge } from "./bridge.js";
import {
  FixtureBridgeError,
  refuseAbsentCapability,
} from "#renderer/services/daemon/refusal.fixture.js";
import { TransportReconnectSignal } from "#renderer/services/transport/reconnect.js";
import { ScenarioEngine } from "#renderer/services/daemon/engine.fixture.js";
import { createFixtureDaemon } from "#renderer/services/daemon/scenario/wire.fixture.js";
import type { Scenario } from "#fixtures/scenarios/script.js";

/** Fixed `app` meta, so a rendered view does not move with the machine. */
export const FIXTURE_APP_META: PlatformBridge["app"] = {
  version: "0.0.0-fixture",
  platform: "darwin",
  arch: "arm64",
  locale: "en-US",
  // 16 GiB, the machine the screen's memory budgets were measured on.
  physicalMemoryBytes: 17_179_869_184,
};

/** The window a fixture console opens first, fixed as the `app` meta is. */
export const FIXTURE_WINDOW_ID: string = consoleWindowId("fixture");

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
  let keyboardMap: KeyboardMap = {};
  let appearanceRecord: AppearanceRecord = DEFAULT_APPEARANCE_RECORD;
  const appearanceHandlers = new Set<(record: AppearanceRecord) => void>();
  const bridge: PlatformBridge = {
    daemon: createFixtureDaemon(scenarioEngine),
    native: {
      showOpenDialog: () => refuseAbsentCapability("native.showOpenDialog"),
      getDroppedFileRef: () => refuseAbsentCapability("native.getDroppedFileRef"),
      savePastedImage: () => refuseAbsentCapability("native.savePastedImage"),
      openExternal: async () => {
        // A fixture window opens no browser; answering lets an `Open …` press settle as it does
        // live, where the page keeps the address beside the control either way.
      },
      openInEditor: () => refuseAbsentCapability("native.openInEditor"),
      listEditors: () => refuseAbsentCapability("native.listEditors"),
      getNotificationPermission: () => refuseAbsentCapability("native.getNotificationPermission"),
      copyToClipboard: async () => {
        // A no-op is safe: nothing reads the result back, and a refusal would make every "copy id"
        // affordance untestable.
      },
      revealInFileExplorer: () => refuseAbsentCapability("native.revealInFileExplorer"),
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
      read: () => refuseAbsentCapability("machineSettings.read"),
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
    window: {
      lastUsedWindowId: FIXTURE_WINDOW_ID,
      setAppearance: async (choice, grounds): Promise<void> => {
        const record: AppearanceRecord = { ...choice, grounds };
        appearanceRecord = record;
        for (const handler of appearanceHandlers) {
          handler(record);
        }
      },
      subscribeAppearance: (handler): Unsubscribe => {
        // A wrapper per subscription, so the same function subscribed twice is two subscriptions.
        const subscription = (record: AppearanceRecord): void => {
          handler(record);
        };
        appearanceHandlers.add(subscription);
        subscription(appearanceRecord);
        return () => {
          appearanceHandlers.delete(subscription);
        };
      },
      setMinimumSize: async () => {
        // Nothing reads the floor back, and the harness sizes the fixture window itself.
      },
      setDefaultSizes: async () => {
        // Nothing reads the sizes back, and the harness sizes the fixture window itself.
      },
      endSafeStart: async () => {
        // A fixture runs no main, so no window place is kept for it to resume.
      },
      // A fixture runs no main to ask for a window; the harness opens every one itself.
      subscribeToReopenRequest: (): Unsubscribe => () => undefined,
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
