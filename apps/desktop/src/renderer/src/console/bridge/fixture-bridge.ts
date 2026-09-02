// The fixture bridge: a real `SidekicksBridge` backed by a scripted scenario.
//
// Every method here is the fixture's answer to a method the preload contract
// declares. Nothing is stubbed away — a method the scenario scripts no reply for
// REJECTS with a named error rather than resolving with `undefined`, because a
// fixture that silently answers "nothing" trains the console to render an empty
// state where the real bridge would render a failure.
//
// A scenario may also script a call that REFUSES, and the two refusal vocabularies
// here are deliberately different values rather than one merged shape. A
// `FixtureBridgeError` says the FIXTURE could not answer (nothing scripted, no
// stand-in for a native capability, the engine torn down under the request); a
// scripted `ScenarioRejectingReply` says the DAEMON refused, and travels as the
// wire's own `{code, message}` envelope, unwrapped. Folding the second into the
// first would put a fixture-scoped code in front of every typed daemon refusal the
// console renders, which is the one thing a fixture must not paraphrase.
//
// Three fixture behaviours are deliberate:
//
//   • **Subscriptions come from the scenario engine, routed by the registered
//     stream table and projected into the registered payload.** `daemon.subscribe`
//     hands the caller beats as they fall due on the frozen clock, so a fixture
//     session is replayable tick-for-tick and a screenshot pins an exact frame — and
//     it hands them only to a subscriber the seam says they reach, in the shape that
//     subscription registers. A fixture that forwarded the whole script to every
//     subscriber delivered `session.created` into a handler that had asked for
//     `run.starting`; a fixture that recognised only ONE stream name delivered
//     nothing at all to the two `run.*` streams the daemon serves, which reads
//     exactly like a quiet session; and a fixture that delivered the ENVELOPE to
//     those two streams sent a frame with no `currentState` on a wire whose whole
//     payload is one. `session-event-streams.ts` routes, `run-stream-projection.ts`
//     projects, and all three defects are gone from one table between them.
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
import type { ConsoleBridge } from "./console-bridge.js";
import {
  FIXTURE_SERVED_GROWTH_OPERATION_IDS,
  createFixtureGrowthPort,
} from "./fixture-growth-port.js";
import { projectRunStreamDelivery } from "./run-stream-projection.js";
import { ScenarioEngine } from "./scenario-engine.js";
import type { ConsoleScenario } from "./scenario.js";
import { SCRIPTED_REPLY_REFUSAL_CODES, settleScriptedReply } from "./scripted-reply.js";
import { subscriptionDeliversEventKind } from "./session-event-streams.js";

/**
 * Why the fixture could not answer. Rendered verbatim; never swallowed.
 *
 * The last two are spread in from `scripted-reply.ts` rather than spelled again
 * here: they name a reply the frozen clock never released, which is a fact about the
 * seam both fixture surfaces share, and the growth port's own closed set spreads the
 * same two. Two independent spellings would be a rename waiting to go half-applied.
 *
 * `beat-unprojectable` is a SCENARIO authoring error rather than a wire one: the
 * beat named a kind a narrowed stream carries and then could not supply what that
 * stream's registered payload requires. It refuses rather than delivering the half
 * it could build, because a projection missing a required member renders as blank
 * and reviews as working.
 */
export const FIXTURE_BRIDGE_REFUSAL_CODES: readonly [
  "reply-unscripted",
  "capability-absent",
  "beat-unprojectable",
  ...typeof SCRIPTED_REPLY_REFUSAL_CODES,
] = [
  "reply-unscripted",
  "capability-absent",
  "beat-unprojectable",
  ...SCRIPTED_REPLY_REFUSAL_CODES,
];

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
    // The port and the set that says what it serves are built together, from one
    // declaration, so a bridge cannot publish a served set its port does not
    // honour. An injectable port used to sit here and nothing ever passed one;
    // keeping it would have meant a caller could hand in a port while the served
    // set beside it still described a different one.
    growth: createFixtureGrowthPort(scenarioEngine),
    growthServedOperations: new Set(FIXTURE_SERVED_GROWTH_OPERATION_IDS),
    source: "fixture",
    scenarioEngine,
  };
}

/**
 * Deliver a scenario's beats to one subscriber, filtered by what it subscribed to.
 *
 * `daemon.subscribe(name, handler)` names either a registered stream or one event
 * type, and `session-event-streams.ts` owns which names are which and what each
 * stream carries. This function performs no routing of its own — a fixture that
 * kept a second reading of the seam would answer a `run.*` stream with silence
 * while the binder above it was passing a name the daemon serves.
 *
 * WHAT REACHES THE HANDLER depends on which arm the name is, because the corpus
 * registers two different answers. `session.subscribe` is the replay-then-tail
 * stream of the whole log and a bare event-type name carries only itself, so both
 * deliver the beat's own envelope. The two `run.*` streams are registered
 * PROJECTIONS — `RunStateChangeEvent | RunRolledBackEvent` and `QueueItemSummary` —
 * and `run-stream-projection.ts` builds one from the beat. Handing those two the
 * envelope, as this function used to, trained every runs surface on a frame the
 * live bridge cannot send: no `kind`, no `sequence`, no nested `payload`, and
 * `currentState` where the envelope has `payload.newState`.
 *
 * A beat the projection cannot build REFUSES here rather than delivering a partial
 * shape, and it refuses by throwing: `core/emitter.ts` runs every sink and re-raises
 * afterwards, so one scenario's authoring error surfaces to whoever advanced the
 * clock without silencing the other subscribers on that beat.
 */
function subscribeToScenario(
  engine: ScenarioEngine,
  subscriptionName: string,
  deliver: (delivered: unknown) => void,
): Unsubscribe {
  return engine.subscribe((events) => {
    for (const event of events) {
      if (!subscriptionDeliversEventKind(subscriptionName, event.kind)) {
        continue;
      }
      const projection = projectRunStreamDelivery(subscriptionName, event);
      if (projection === undefined) {
        deliver(event);
        continue;
      }
      if (projection.status === "unprojectable") {
        throw new FixtureBridgeError(subscriptionName, "beat-unprojectable", projection.detail);
      }
      deliver(projection.delivery);
    }
  });
}

/**
 * Answer one request/response call from the scenario, or reject by name.
 *
 * The classification is `scripted-reply.ts`'s — this is the arm that turns each
 * settlement into what a `SidekicksBridge` method may do, which is resolve or reject
 * and nothing else. Three of the four settlements are rejections here, and each
 * rejects with a different value on purpose: an unscripted call is a fixture
 * AUTHORING error, a reply the clock never released is a fixture failure carrying the
 * shared code, and a scripted daemon refusal is thrown VERBATIM and unwrapped.
 *
 * That last one is the whole point of the refusal arm: it is the daemon's refusal,
 * not the fixture's, and `src/shared/wire-errors.ts` records that a wire refusal
 * reaches a renderer either as this plain object or as an `Error` carrying the same
 * `code` — `normalizeWireRejection` renders both as `code: message`. Wrapping it in a
 * `FixtureBridgeError` would replace the code a surface exists to show with a
 * fixture-scoped one and make the rendered refusal a thing the live bridge never
 * produces.
 */
async function resolveScriptedReply(engine: ScenarioEngine, call: string): Promise<unknown> {
  const settlement = await settleScriptedReply(engine, call);
  switch (settlement.status) {
    case "unscripted":
      throw new FixtureBridgeError(
        call,
        "reply-unscripted",
        `scenario "${engine.scenario.id}" scripts no reply. Add one to the scenario rather than letting the surface render an empty result for a call that would have failed.`,
      );
    case "unanswered":
      throw new FixtureBridgeError(call, settlement.code, settlement.detail);
    case "refused":
      throw settlement.refusal;
    case "resolved":
      return settlement.value;
  }
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
