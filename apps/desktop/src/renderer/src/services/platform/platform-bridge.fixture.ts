// The fixture bridge: a real platform bridge backed by a scripted scenario. The daemon half is
// `services/daemon/daemon.fixture.ts`; this assembles it with the host's other answers.
//
// Native calls refuse rather than pretend, so a view cannot ship a code path nobody ran against
// the real dialog. The `app` meta is fixed so a screenshot does not shift with the machine. The
// keyboard map is held in memory: the first read is empty and a write is read back, which is the
// Keyboard page's whole contract with main.

import type { DaemonEvent, DaemonSubscribeParams } from "@ai-sidekicks/contracts";
import { DAEMON_STATUS_TOPIC } from "@shared/daemon-status-topic.js";
import type {
  CpInput,
  CpOutput,
  CpProcedure,
  KeyboardMap,
  KeyboardMapReading,
  Unsubscribe,
  UpdateState,
} from "@shared/preload-api.js";
import type { PlatformBridge } from "./platform-bridge.js";
import { resolveScriptedReply } from "@renderer/services/daemon/scripted-reply.fixture.js";
import {
  FixtureBridgeError,
  refuseAbsentCapability,
} from "@renderer/services/daemon/refusal.fixture.js";
import { TransportReconnectSignal } from "@renderer/services/transport/transport-reconnect.js";
import { ScenarioEngine } from "@renderer/services/daemon/engine.fixture.js";
import { createFixtureDaemon } from "@renderer/services/daemon/daemon.fixture.js";
import type { Scenario } from "../../../../../fixtures/scenario.js";

/** Fixed `app` meta, so a screenshot does not move with the machine. */
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
      // The supervisor's topic is main's, and the fixture has no main to publish it.
      subscribe: ((
        event: DaemonEvent | typeof DAEMON_STATUS_TOPIC,
        params: DaemonSubscribeParams<DaemonEvent>,
        handler: () => void,
      ) =>
        event === DAEMON_STATUS_TOPIC
          ? refuseAbsentSubscription("daemon.subscribe(daemon.status)")
          : fixtureDaemon.subscribe(
              event,
              params,
              handler,
            )) as PlatformBridge["daemon"]["subscribe"],
      requestStart: () => refuseAbsentCapability("daemon.requestStart"),
      requestUpdate: () => refuseAbsentCapability("daemon.requestUpdate"),
      cancelUpdate: () => refuseAbsentCapability("daemon.cancelUpdate"),
      subscribeUpdate: () => refuseAbsentSubscription("daemon.subscribeUpdate"),
      requestRestore: () => refuseAbsentCapability("daemon.requestRestore"),
      listPlaces: () => refuseAbsentCapability("daemon.listPlaces"),
      subscribePlaces: () => refuseAbsentSubscription("daemon.subscribePlaces"),
      requestMove: () => refuseAbsentCapability("daemon.requestMove"),
      cancelMove: () => refuseAbsentCapability("daemon.cancelMove"),
      subscribeMove: () => refuseAbsentSubscription("daemon.subscribeMove"),
    },
    controlPlane: {
      call: async <ProcedureName extends CpProcedure>(
        procedure: ProcedureName,
        input: CpInput<ProcedureName>,
      ): Promise<CpOutput<ProcedureName>> =>
        (await resolveScriptedReply(scenarioEngine, procedure, input)) as CpOutput<ProcedureName>,
    },
    native: {
      showOpenDialog: () => refuseAbsentCapability("native.showOpenDialog"),
      showSaveDialog: () => refuseAbsentCapability("native.showSaveDialog"),
      getDroppedFileRef: () => refuseAbsentCapability("native.getDroppedFileRef"),
      savePastedImage: () => refuseAbsentCapability("native.savePastedImage"),
      showMessageBox: () => refuseAbsentCapability("native.showMessageBox"),
      showNotification: () => {
        // Fire-and-forget on the live bridge too; a throw from a `void` method the caller cannot
        // catch would be worse than doing nothing observable.
      },
      getNotificationPermission: () => refuseAbsentCapability("native.getNotificationPermission"),
      openExternal: () => refuseAbsentCapability("native.openExternal"),
      copyToClipboard: async () => {
        // A no-op is safe: nothing reads the result back, and a refusal would make every "copy id"
        // affordance untestable.
      },
      openInEditor: () => refuseAbsentCapability("native.openInEditor"),
      openInTerminal: () => refuseAbsentCapability("native.openInTerminal"),
      revealInFileExplorer: () => refuseAbsentCapability("native.revealInFileExplorer"),
      listEditors: () => refuseAbsentCapability("native.listEditors"),
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
      subscribeToNavigationRequest: () =>
        refuseAbsentSubscription("window.subscribeToNavigationRequest"),
      setAppearance: () => refuseAbsentCapability("window.setAppearance"),
      subscribeAppearance: () => refuseAbsentSubscription("window.subscribeAppearance"),
      subscribeFullscreen: () => refuseAbsentSubscription("window.subscribeFullscreen"),
      setMinimumSize: () => refuseAbsentCapability("window.setMinimumSize"),
    },
    browser: {
      publishPaneRect: () => refuseAbsentSubscription("browser.publishPaneRect"),
      act: () => refuseAbsentCapability("browser.act"),
      capturePage: () => refuseAbsentCapability("browser.capturePage"),
      subscribe: () => refuseAbsentSubscription("browser.subscribe"),
      publishPageChords: () => refuseAbsentSubscription("browser.publishPageChords"),
      subscribePageChords: () => refuseAbsentSubscription("browser.subscribePageChords"),
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
