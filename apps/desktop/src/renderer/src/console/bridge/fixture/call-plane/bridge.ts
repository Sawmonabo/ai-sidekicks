// The fixture bridge: a real `DesktopBridge` backed by a scripted scenario.
//
// Every method here is the fixture's answer to a method the preload contract
// declares. Nothing is stubbed away — a method the scenario scripts no reply for
// REJECTS with a named error rather than resolving with `undefined`, because a
// fixture that silently answers "nothing" trains the console to render an empty
// state where the real bridge would render a failure.
//
// WHAT THIS MODULE IS, after the split: the composition. The two doors a bridge has are
// `call-door.ts` and `subscriptions.ts`, and the refusal vocabulary both
// raise is `refusal.ts`. Each of those is a claim with its own reasoning; this
// file is the object they are wired into, and it is the one every console surface
// reaches the fixture by.
//
// Two fixture behaviours are this module's own:
//
//   • **Native surfaces refuse rather than pretend.** `showOpenDialog` under the
//     fixture cannot open a dialog, so it rejects with a fixture-scoped error. A
//     fixture that returned a plausible path would let a surface ship with a code
//     path nobody has ever run against the real dialog.
//   • **`app` meta is fixed.** Version, platform, arch, locale are constants, so a
//     screenshot baseline does not shift when the developer's machine does.

import type {
  AuxiliaryWindowControls,
  CpInput,
  CpOutput,
  CpProcedure,
  DaemonEvent,
  DaemonEventPayload,
  DaemonMethod,
  DaemonParams,
  DaemonResult,
  DesktopBridge,
  Unsubscribe,
  UpdateState,
} from "@ai-sidekicks/contracts";
import type { ConsoleBridge } from "../../console-bridge.js";
import { resolveScriptedReply, assertScriptedReplyOnContract } from "./call-door.js";
import { refuseAbsentCapability } from "./refusal.js";
import { TransportReconnectSignal } from "../../transport/transport-reconnect.js";
import { subscribeToScenario, subscribeToScenarioRelay } from "./subscriptions.js";
import { ScenarioEngine } from "../../scenario/runtime/index.js";
import type { ConsoleScenario } from "../../scenario/runtime/index.js";

/** Fixed `app` meta, so a baseline screenshot does not move with the machine. */
export const FIXTURE_APP_META: DesktopBridge["app"] = {
  version: "0.0.0-fixture",
  platform: "darwin",
  arch: "arm64",
  locale: "en-US",
};

export interface FixtureBridgeOptions {
  readonly scenario: ConsoleScenario;
}

/** Build the fixture bridge for one scenario. */
export function createFixtureBridge(options: FixtureBridgeOptions): ConsoleBridge {
  const scenarioEngine = new ScenarioEngine({ scenario: options.scenario });
  const transportReconnect = new TransportReconnectSignal();
  const updaterState: UpdateState = options.scenario.updaterState ?? { status: "idle" };
  const desktopBridge: DesktopBridge = {
    daemon: {
      // `DaemonResult<M>` is a stub that resolves to `unknown`, so the assertion
      // narrows nothing today; it is here so that when the daemon lands the real
      // method-to-result mapping, this line becomes the one place the fixture
      // has to prove its scripted replies match the wire. Until then the check
      // beside it does that job for every method the corpus has already registered.
      call: async <MethodName extends DaemonMethod>(
        method: MethodName,
        params: DaemonParams<MethodName>,
      ): Promise<DaemonResult<MethodName>> =>
        assertScriptedReplyOnContract(
          method,
          await resolveScriptedReply(scenarioEngine, method, params),
        ) as DaemonResult<MethodName>,
      subscribe: <EventName extends DaemonEvent>(
        event: EventName,
        handler: (payload: DaemonEventPayload<EventName>) => void,
      ): Unsubscribe =>
        subscribeToScenario(scenarioEngine, event, (delivered) => {
          handler(delivered as DaemonEventPayload<EventName>);
        }),
    },
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
        // Notifications are fire-and-forget on the real bridge too, so the fixture
        // matches its signature by doing nothing observable rather than throwing
        // from a `void` method the caller cannot catch.
      },
      openExternal: () => refuseAbsentCapability("native.openExternal"),
      copyToClipboard: async () => {
        // Clipboard writes are safe to no-op: nothing reads the result back, and a
        // refusal here would make every "copy id" affordance untestable.
      },
      revealInFileExplorer: () => refuseAbsentCapability("native.revealInFileExplorer"),
    },
    shell: {
      // The fixture is a scripted SESSION, not a scripted shell: no scenario opens a
      // second window, so nothing here could ever press the chord that raises this.
      // It answers with a disposer and reports nothing — the `attentionSubscribe`
      // posture, and a reading rather than a refusal: this bridge is not declining to
      // say when the shell asked, it has no shell behind it that could ask.
      subscribeToComposerFocusRequest: (): Unsubscribe => () => undefined,
    },
    update: {
      // The scenario's own declaration, or the bare `idle` this fixture answered
      // before scenarios could state one. The default carries NO `lastCheckedAt`
      // deliberately: that member is optional on the wire, absent means no check has
      // ever completed, and a fixture that supplied an instant on every scenario
      // would make the never-checked arm unreachable in the whole deck.
      getState: async (): Promise<UpdateState> => updaterState,
      subscribe: (handler): Unsubscribe => {
        handler(updaterState);
        return () => undefined;
      },
      requestCheck: () => refuseAbsentCapability("update.requestCheck"),
      requestRestart: () => refuseAbsentCapability("update.requestRestart"),
    },
    window: WINDOWLESS_AUXILIARY_CONTROLS,
    app: FIXTURE_APP_META,
  };

  return {
    desktopBridge,
    // The attention plane moves with playback, so a delivered beat IS the moment it
    // may have changed.
    //
    // TAIL-ONLY, deliberately: a subscriber attaches to re-read a WHOLE projection,
    // and replaying the delivered prefix would cost one read per beat already folded
    // into the answer it is about to take.
    attentionSubscribe: (onAttentionChange) =>
      scenarioEngine.subscribe(() => {
        onAttentionChange();
      }),
    transportReconnect,
    source: "fixture",
    scenarioEngine,
  };
}

/**
 * The `window` namespace a fixture carries.
 *
 * Present because the fixture is shape-identical to `DesktopBridge` namespace for
 * namespace, and refusing because there is no process here that could open a window.
 * The two subscriptions hand back a disposer and report nothing, which is what a
 * signal with no producer behind it is.
 */
const WINDOWLESS_AUXILIARY_CONTROLS: AuxiliaryWindowControls = {
  detachPane: () => refuseAbsentCapability("window.detachPane"),
  focusAuxiliary: () => refuseAbsentCapability("window.focusAuxiliary"),
  closeAuxiliary: () => refuseAbsentCapability("window.closeAuxiliary"),
  subscribePaneErrors: () => () => undefined,
  subscribePaneReturns: () => () => undefined,
};
