// The fixture bridge: a real platform bridge backed by a scripted scenario.
//
// Every member is the fixture's answer to one the preload declares. The daemon half is
// `services/daemon/daemon.fixture.ts`; this module assembles it with the host's other answers.
//
//   • **Native surfaces refuse rather than pretend.** `showOpenDialog` under the fixture cannot
//     open a dialog, so it rejects with a fixture-scoped error. A fixture that returned a
//     plausible path would let a surface ship with a code path nobody has run against the
//     real dialog.
//   • **`app` meta is fixed.** Version, platform, arch and locale are constants, so a
//     screenshot does not shift when the developer's machine does.

import type {
  CpInput,
  CpOutput,
  CpProcedure,
  Unsubscribe,
  UpdateState,
} from "@shared/preload-api.js";
import type { PlatformBridge } from "./platform-bridge.js";
import { resolveScriptedReply } from "@renderer/services/daemon/scripted-reply.fixture.js";
import { refuseAbsentCapability } from "@renderer/services/daemon/refusal.fixture.js";
import { TransportReconnectSignal } from "@renderer/services/transport/transport-reconnect.js";
import { subscribeToScenarioRelay } from "@renderer/services/daemon/scenario-subscriptions.fixture.js";
import { ScenarioEngine } from "@renderer/services/daemon/engine.fixture.js";
import { createFixtureDaemon } from "@renderer/services/daemon/daemon.fixture.js";
import type { Scenario } from "../../../../../fixtures/scenario.js";

/** Fixed `app` meta, so a screenshot does not move with the machine. */
export const FIXTURE_APP_META: PlatformBridge["app"] = {
  version: "0.0.0-fixture",
  platform: "darwin",
  arch: "arm64",
  locale: "en-US",
};

export interface FixtureBridgeOptions {
  readonly scenario: Scenario;
}

/** Build the fixture bridge for one scenario. */
export function createFixtureBridge(options: FixtureBridgeOptions): PlatformBridge {
  const scenarioEngine = new ScenarioEngine({ scenario: options.scenario });
  const updaterState: UpdateState = options.scenario.updaterState ?? { status: "idle" };
  return {
    daemon: createFixtureDaemon(scenarioEngine),
    controlPlane: {
      call: async <ProcedureName extends CpProcedure>(
        procedure: ProcedureName,
        input: CpInput<ProcedureName>,
      ): Promise<CpOutput<ProcedureName>> =>
        (await resolveScriptedReply(scenarioEngine, procedure, input)) as CpOutput<ProcedureName>,
      subscribeRelay: (sessionId, handler): Unsubscribe =>
        subscribeToScenarioRelay(scenarioEngine, sessionId, handler),
    },
    native: {
      showOpenDialog: () => refuseAbsentCapability("native.showOpenDialog"),
      showSaveDialog: () => refuseAbsentCapability("native.showSaveDialog"),
      showMessageBox: () => refuseAbsentCapability("native.showMessageBox"),
      showNotification: () => {
        // Notifications are fire-and-forget on the live bridge too, so the fixture matches its
        // signature by doing nothing observable rather than throwing from a `void` method the
        // caller cannot catch.
      },
      getNotificationPermission: () => refuseAbsentCapability("native.getNotificationPermission"),
      openExternal: () => refuseAbsentCapability("native.openExternal"),
      copyToClipboard: async () => {
        // Clipboard writes are safe to no-op: nothing reads the result back, and a refusal here
        // would make every "copy id" affordance untestable.
      },
      revealInFileExplorer: () => refuseAbsentCapability("native.revealInFileExplorer"),
    },
    update: {
      // The scenario's own declaration, or a bare `idle`. The default carries no
      // `lastCheckedAt` deliberately: that member is optional, absent means no check has ever
      // completed, and a fixture that supplied an instant on every scenario would make the
      // never-checked arm unreachable.
      getState: async (): Promise<UpdateState> => updaterState,
      subscribe: (handler): Unsubscribe => {
        handler(updaterState);
        return () => undefined;
      },
      requestCheck: () => refuseAbsentCapability("update.requestCheck"),
      requestRestart: () => refuseAbsentCapability("update.requestRestart"),
    },
    app: FIXTURE_APP_META,
    transportReconnect: new TransportReconnectSignal(),
    source: "fixture",
    scenarioEngine,
  };
}
