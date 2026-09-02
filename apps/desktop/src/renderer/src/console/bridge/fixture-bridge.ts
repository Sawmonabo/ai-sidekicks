// The fixture bridge: a real `SidekicksBridge` backed by a scripted scenario.
//
// Every method here is the fixture's answer to a method the preload contract
// declares. Nothing is stubbed away — a method the scenario scripts no reply for
// REJECTS with a named error rather than resolving with `undefined`, because a
// fixture that silently answers "nothing" trains the console to render an empty
// state where the real bridge would render a failure.
//
// Three fixture behaviours are deliberate:
//
//   • **Subscriptions come from the scenario engine, filtered by what was asked
//     for.** `daemon.subscribe` hands the caller beats as they fall due on the
//     frozen clock, so a fixture session is replayable tick-for-tick and a
//     screenshot pins an exact frame — and it hands them only to a subscriber that
//     named them. A fixture that forwarded the whole script to every subscriber
//     delivered `session.created` into a handler that had asked for `run.started`,
//     which is a frame the live bridge cannot produce and therefore a screenshot
//     or an end-to-end result that proves nothing about the shipped console.
//   • **Native surfaces refuse rather than pretend.** `showOpenDialog` under the
//     fixture cannot open a dialog, so it rejects with a fixture-scoped error. A
//     fixture that returned a plausible path would let a surface ship with a code
//     path nobody has ever run against the real dialog.
//   • **`app` meta is fixed.** Version, platform, arch, locale are constants, so a
//     screenshot baseline does not shift when the developer's machine does.

import {
  type CpOutput,
  type CpProcedure,
  type DaemonEvent,
  type DaemonEventPayload,
  type DaemonMethod,
  type DaemonResult,
  type SidekicksBridge,
  type Unsubscribe,
  type UpdateState,
} from "@ai-sidekicks/contracts";
import { ConsoleRefusalError, refuse } from "../core/index.js";
import type { ConsoleSessionEvent } from "../store/index.js";
import { isSessionEventStream, type ConsoleBridge } from "./console-bridge.js";
import { createRefusingGrowthPort, type GrowthPort } from "./growth-port.js";
import { ScenarioEngine, type ConsoleScenario } from "./scenario.js";

/** Why the fixture could not answer. Rendered verbatim; never swallowed. */
export const FIXTURE_BRIDGE_REFUSAL_CODES = [
  "reply-unscripted",
  "capability-absent",
  "reply-abandoned",
  "reply-backlog-full",
] as const;

/** One fixture refusal code. Derived, so the vocabulary is declared exactly once. */
export type FixtureBridgeRefusalCode = (typeof FIXTURE_BRIDGE_REFUSAL_CODES)[number];

/** The subsystem name every refusal this module raises carries. */
export const FIXTURE_BRIDGE_REFUSAL_ORIGIN = "fixture-bridge";

/**
 * Thrown when a surface asks the fixture for something no scenario scripts.
 *
 * A `ConsoleRefusalError` and not a bare `Error` carrying a code of its own.
 * `core/refusal.ts` names this module as one of the five that had minted their own
 * refusal vocabulary, and the cost was concrete: a surface wanting to render a
 * fixture failure beside a growth-port one had to translate between two shapes to
 * reach one renderer. It stays a NAMED subclass because a fixture failure is worth
 * catching by name — the seam has to travel as an exception, since these are
 * rejections from methods whose signatures the preload contract fixes.
 *
 * `call` is kept beside the refusal rather than folded into `detail`: it names a
 * bridge method, which is machine-readable provenance, and `detail` is the sentence
 * a person acts on.
 */
export class FixtureBridgeError extends ConsoleRefusalError {
  public readonly call: string;

  public constructor(call: string, code: FixtureBridgeRefusalCode, detail: string) {
    super(refuse(FIXTURE_BRIDGE_REFUSAL_ORIGIN, code, `${call} — ${detail}`));
    this.name = "FixtureBridgeError";
    this.call = call;
  }
}

/** Fixed `app` meta, so a baseline screenshot does not move with the machine. */
export const FIXTURE_APP_META: SidekicksBridge["app"] = {
  version: "0.0.0-fixture",
  platform: "darwin",
  arch: "arm64",
  locale: "en-US",
};

export interface FixtureBridgeOptions {
  readonly scenario: ConsoleScenario;
  /**
   * The growth port the fixture serves. Defaults to the refusing port, so a
   * scenario that has not scripted a growth wire renders the "not checked"
   * absence exactly as the live bridge would.
   */
  readonly growth?: GrowthPort;
}

/** Build the fixture bridge for one scenario. */
export function createFixtureBridge(options: FixtureBridgeOptions): ConsoleBridge {
  const scenarioEngine = new ScenarioEngine({ scenario: options.scenario });
  const sidekicks: SidekicksBridge = {
    daemon: {
      // `DaemonResult<M>` is a Plan-007 stub that resolves to `unknown`, so the
      // assertion narrows nothing today; it is here so that when Plan-007 lands the
      // real method-to-result mapping, this line becomes the one place the fixture
      // has to prove its scripted replies match the wire.
      call: async <MethodName extends DaemonMethod>(
        method: MethodName,
      ): Promise<DaemonResult<MethodName>> =>
        (await resolveScriptedReply(scenarioEngine, method)) as DaemonResult<MethodName>,
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
      ): Promise<CpOutput<ProcedureName>> =>
        (await resolveScriptedReply(scenarioEngine, procedure)) as CpOutput<ProcedureName>,
      // Unfiltered, and not by omission: `subscribeRelay` names a SESSION rather
      // than an event, and a scenario scripts exactly one session — so every beat
      // it plays belongs to the session any caller could be asking for. The
      // filter that `daemon.subscribe` needs has nothing to key on here.
      subscribeRelay: (_sessionId, handler): Unsubscribe =>
        scenarioEngine.subscribe((events) => {
          for (const event of events) {
            handler(event);
          }
        }),
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
      createCredential: () => refuseAbsentCapability("webAuthn.createCredential"),
      getAssertion: () => refuseAbsentCapability("webAuthn.getAssertion"),
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
    growth: options.growth ?? createRefusingGrowthPort(),
    source: "fixture",
    scenarioEngine,
  };
}

/**
 * Deliver a scenario's beats to one subscriber, filtered by what it subscribed to.
 *
 * `daemon.subscribe(name, handler)` names either a whole-session stream or one
 * event type, and `console-bridge.ts` owns which names are which. A stream gets
 * every beat; anything else gets the beats whose `kind` it named.
 *
 * The beat's own envelope is what reaches the handler on BOTH arms, deliberately.
 * `DaemonEventPayload<E>` is a Plan-007 stub that resolves to `unknown`, so there
 * is no registered per-event payload shape to project a beat down to — and a
 * fixture that invented one would be putting a wire fact into the one module that
 * has no contract to check it against.
 */
function subscribeToScenario(
  engine: ScenarioEngine,
  subscriptionName: string,
  deliver: (event: ConsoleSessionEvent) => void,
): Unsubscribe {
  const carriesWholeStream = isSessionEventStream(subscriptionName);
  return engine.subscribe((events) => {
    for (const event of events) {
      if (carriesWholeStream || event.kind === subscriptionName) {
        deliver(event);
      }
    }
  });
}

async function resolveScriptedReply(engine: ScenarioEngine, call: string): Promise<unknown> {
  const reply = engine.replyFor(call);
  if (reply === undefined) {
    throw new FixtureBridgeError(
      call,
      "reply-unscripted",
      `scenario "${engine.scenario.id}" scripts no reply. Add one to the scenario rather than letting the surface render an empty result for a call that would have failed.`,
    );
  }
  if (reply.afterMs !== undefined && reply.afterMs > 0) {
    // Latency is scripted rather than real: the frozen clock is the only clock, so
    // the reply is PARKED on it and the caller advances the engine to release it.
    // Spending the delay here instead would settle the promise on this same turn —
    // no loading state would ever be observable — and would deliver every beat
    // inside the delay as a side effect of a read.
    const outcome = await engine.holdReply(reply.afterMs);
    if (outcome === "abandoned") {
      throw new FixtureBridgeError(
        call,
        "reply-abandoned",
        "the scenario engine was torn down before the frozen clock reached this reply. Advance the engine before disposing it, or drive this surface from a scenario that scripts no latency for the call.",
      );
    }
    if (outcome === "backlog-full") {
      throw new FixtureBridgeError(
        call,
        "reply-backlog-full",
        `the fixture is already holding ${String(engine.pendingReplyCount)} delayed replies and takes no more. Advance the frozen clock to release them; a backlog this size means something is issuing requests without ever moving the scenario forward.`,
      );
    }
  }
  return reply.result;
}

/**
 * Reject one call the fixture cannot stand in for.
 *
 * Named for what it refuses rather than `refuse`, which is `core/refusal.ts`'s
 * builder and is imported above: two functions called `refuse` in one module, one
 * returning a refusal and one rejecting with it, is the kind of collision a reader
 * resolves wrongly once and then trusts.
 */
function refuseAbsentCapability(call: string): Promise<never> {
  return Promise.reject(
    new FixtureBridgeError(
      call,
      "capability-absent",
      "this capability needs the real main process and has no fixture stand-in",
    ),
  );
}
