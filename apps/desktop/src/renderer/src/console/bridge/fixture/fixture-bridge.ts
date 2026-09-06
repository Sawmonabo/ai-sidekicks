// The fixture bridge: a real `SidekicksBridge` backed by a scripted scenario.
//
// Every method here is the fixture's answer to a method the preload contract
// declares. Nothing is stubbed away — a method the scenario scripts no reply for
// REJECTS with a named error rather than resolving with `undefined`, because a
// fixture that silently answers "nothing" trains the console to render an empty
// state where the real bridge would render a failure.
//
// WHAT THIS MODULE IS, after the split: the composition. The two doors a bridge has are
// `fixture-call-door.ts` and `fixture-subscriptions.ts`, and the refusal vocabulary both
// raise is `fixture-refusal.ts`. Each of those is a claim with its own reasoning; this
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
  CpInput,
  CpOutput,
  CpProcedure,
  DaemonEvent,
  DaemonEventPayload,
  DaemonMethod,
  DaemonParams,
  DaemonResult,
  SidekicksBridge,
  Unsubscribe,
  UpdateState,
} from "@ai-sidekicks/contracts";
import type { ConsoleBridge } from "../console-bridge.js";
import { resolveScriptedReply, assertScriptedReplyOnContract } from "./fixture-call-door.js";
import { createFixtureGrowthPort } from "./fixture-growth-port.js";
import { FIXTURE_SERVED_GROWTH_OPERATION_IDS } from "./fixture-served-operations.js";
import { refuseAbsentCapability } from "./fixture-refusal.js";
import { encodeCeremonyResolution } from "../web-authn/index.js";
import { subscribeToScenario, subscribeToScenarioRelay } from "./fixture-subscriptions.js";
import { readRuntimeNodeRosterFromScenario } from "./fixture-runtime-node-roster.js";
import { subscribeRuntimeNodePresence } from "../runtime-nodes/index.js";
import { createScriptedPaneViewHost } from "./pane-view-host-script.js";
import { ScenarioEngine } from "../scenario-runtime/index.js";
import type { ConsoleScenario } from "../scenario-runtime/index.js";

/** Fixed `app` meta, so a baseline screenshot does not move with the machine. */
export const FIXTURE_APP_META: SidekicksBridge["app"] = {
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
  // One host per bridge, because the assertion sequence is per WINDOW: see its own
  // declaration for why the count lives here and not on the scenario.
  const ceremonyHost = new ScriptedCeremonyRunner(scenarioEngine);
  const sidekicks: SidekicksBridge = {
    daemon: {
      // `DaemonResult<M>` is a Plan-007 stub that resolves to `unknown`, so the
      // assertion narrows nothing today; it is here so that when Plan-007 lands the
      // real method-to-result mapping, this line becomes the one place the fixture
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
    webAuthn: {
      // The two ceremony methods answer from the scenario's stated host, and refuse
      // for a scenario that states none — the `runtimeNodeRoster` posture, for the
      // same reason: "this host has no authenticator" is a state the sign-in card
      // draws and "nobody asked" is not, and a fixture that resolved the first for
      // the second would teach the card to report a probe result nothing probed.
      //
      // The two methods answer from ONE stated host, and that is the seam rather than
      // an economy: `Spec-023 §WebAuthn Credential Flow` has one ceremony with one
      // machine behind it, so a scenario whose registration succeeded while its
      // sign-in reported no authenticator would be describing two machines. What they
      // do not share is a single answer: an assertion is put twice — once to sign in
      // and once to collect the device grant main is holding — so the assertions are
      // a sequence, and enrolment has its own.
      createCredential: async () => ceremonyHost.register(),
      getAssertion: async () => ceremonyHost.assert(),
      // AND THE PRF DERIVATION STAYS REFUSED UNDER EVERY SCENARIO. It is main's:
      // step 5 of that flow derives the wrapping key "in its own address space" and
      // never exposes it, and I-023-16 leaves the renderer choosing no salt to derive
      // against. A fixture that answered would be standing in for a call this console
      // may not make — so the one honest fixture answer is the one below.
      deriveKeyMaterial: () => refuseAbsentCapability("webAuthn.deriveKeyMaterial"),
    },
    update: {
      getState: async (): Promise<UpdateState> => ({ status: "idle" }),
      subscribe: (handler): Unsubscribe => {
        handler({ status: "idle" });
        return () => undefined;
      },
      requestCheck: () => refuseAbsentCapability("update.requestCheck"),
      requestRestart: () => refuseAbsentCapability("update.requestRestart"),
    },
    app: FIXTURE_APP_META,
  };

  return {
    sidekicks,
    // The port and the set that says what it serves are built together, from one
    // declaration, so a bridge cannot publish a served set its port does not
    // honour. An injectable port used to sit here and nothing ever passed one;
    // keeping it would have meant a caller could hand in a port while the served
    // set beside it still described a different one.
    growth: createFixtureGrowthPort(scenarioEngine),
    growthServedOperations: new Set(FIXTURE_SERVED_GROWTH_OPERATION_IDS),
    // The roster read is answered from the scenario's own frames rather than from
    // the reply table, because a roster moves and a reply does not. The presence
    // subscription is answered by this bridge's OWN `daemon.subscribe` above —
    // which already routes scenario beats by the registered event name — so the
    // fixture keeps no second reading of which names a presence subscription
    // carries, and a beat this scenario plays reaches the roster the same way it
    // would reach it from the daemon.
    runtimeNodeRosterRead: async (request) =>
      readRuntimeNodeRosterFromScenario(scenarioEngine, request),
    runtimeNodePresenceSubscribe: (sessionId, onPresenceChange) =>
      subscribeRuntimeNodePresence(sidekicks, sessionId, onPresenceChange),
    // 12.11's scripted arm. Without it the resolver could only ever return the
    // unavailable host, so every geometry publish under the fixture and under the
    // end-to-end runs was suppressed and the attached path the wiring table
    // promises was exercised by nothing.
    paneViewHostScript: createScriptedPaneViewHost(),
    source: "fixture",
    scenarioEngine,
  };
}

/** The two ceremony operations one window can put, answered from one stated host. */
interface ScriptedCeremonyHost {
  assert(): Promise<object>;
  register(): Promise<object>;
}

/**
 * Answer this window's ceremony calls from the running scenario's stated host.
 *
 * Rejects rather than resolving where the scenario states nothing, through the same
 * `capability-absent` refusal every other unstandable native surface takes, so the
 * sign-in adapter reads one absence and not two.
 *
 * IT COUNTS ASSERTIONS, IN A PRIVATE FIELD RATHER THAN A CLOSURE. It is scoped
 * to the bridge — one window, one host — so a replayed scenario opens a fresh bridge
 * and starts at the first answer again, which is what keeps the fixture deterministic.
 * The last scripted answer repeats for every call past the sequence, so a script
 * states as many steps as it has and no scenario has to pad one.
 */
class ScriptedCeremonyRunner implements ScriptedCeremonyHost {
  readonly #scenarioEngine: ScenarioEngine;
  #answeredAssertions = 0;

  public constructor(scenarioEngine: ScenarioEngine) {
    this.#scenarioEngine = scenarioEngine;
  }

  public async assert(): Promise<object> {
    const scripted = this.#scenarioEngine.scenario.signInCeremony;
    if (scripted === undefined) {
      return refuseAbsentCapability("webAuthn.getAssertion");
    }
    const { assertions } = scripted;
    const position = Math.min(this.#answeredAssertions, assertions.length - 1);
    this.#answeredAssertions += 1;
    // `assertions` is a non-empty tuple and `position` is clamped to its last index,
    // so the read cannot miss. Asserted rather than branched: a fallback here would
    // be a second answer for the same call that no case could ever reach.
    const answer = assertions[position] as (typeof assertions)[number];
    return encodeCeremonyResolution(answer);
  }

  public async register(): Promise<object> {
    const scripted = this.#scenarioEngine.scenario.signInCeremony?.registration;
    return scripted === undefined
      ? refuseAbsentCapability("webAuthn.createCredential")
      : encodeCeremonyResolution(scripted);
  }
}
