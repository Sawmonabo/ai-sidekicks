// The fixture daemon: the daemon calls and subscriptions a scripted scenario answers.
//
// A method the scenario scripts no reply for REJECTS with a named error rather than resolving
// with `undefined`, because a fixture that silently answers "nothing" trains a screen to render
// an empty state where the live daemon would render a failure.

import type {
  DaemonEvent,
  DaemonEventPayload,
  DaemonMethod,
  DaemonParams,
  DaemonResult,
} from "@ai-sidekicks/contracts";
import type { Unsubscribe } from "@shared/preload-api.js";
import type {
  AttentionSubscribe,
  DesktopBridge,
} from "@renderer/services/platform/platform-bridge.js";
import type { ScenarioEngine } from "./engine.fixture.js";
import { assertScriptedReplyOnContract, resolveScriptedReply } from "./scripted-reply.fixture.js";
import { subscribeToScenario } from "./scenario-subscriptions.fixture.js";

/** The daemon namespace answered from one scenario's engine. */
export function createFixtureDaemon(scenarioEngine: ScenarioEngine): DesktopBridge["daemon"] {
  return {
    // `DaemonResult<M>` is a stub that resolves to `unknown`, so the assertion narrows nothing
    // today; when the daemon lands the real method-to-result mapping, this line is the one
    // place the fixture proves its scripted replies match the wire. Until then the check
    // beside it does that job for every method the corpus has registered.
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
  };
}

/**
 * Attention moving under the fixture. The attention plane moves with playback, so a delivered
 * beat is the moment it may have changed.
 *
 * Tail-only, deliberately: a subscriber attaches to re-read a whole projection, and replaying
 * the delivered prefix would cost one read per beat already folded into the answer it is about
 * to take.
 */
export function createFixtureAttentionSubscribe(
  scenarioEngine: ScenarioEngine,
): AttentionSubscribe {
  return (onAttentionChange) =>
    scenarioEngine.subscribe(() => {
      onAttentionChange();
    });
}
