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
import type { DaemonWire, Unsubscribe } from "@shared/preload-api.js";
import type { ScenarioEngine } from "./engine.fixture.js";
import { assertScriptedReplyOnContract, resolveScriptedReply } from "./scripted-reply.fixture.js";
import { subscribeToScenario } from "./scenario-subscriptions.fixture.js";

/** The daemon namespace answered from one scenario's engine. */
export function createFixtureDaemon(scenarioEngine: ScenarioEngine): DaemonWire {
  return {
    // A scenario scripts its replies as untyped data, so the reply is cast to the method's
    // `DaemonResult<M>` here, the one place the fixture claims a type for it. The check it
    // passes through holds every method the console calls to that method's registered
    // response schema; a method the console does not call passes unchecked.
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
      // The scenario composes each delivery from its authored beats as untyped data, so the
      // payload is cast to the subscription's `DaemonEventPayload<E>`; the console parses
      // every delivery at its own boundary, as it does the live bridge's.
      subscribeToScenario(scenarioEngine, event, (delivered) => {
        handler(delivered as DaemonEventPayload<EventName>);
      }),
  };
}
