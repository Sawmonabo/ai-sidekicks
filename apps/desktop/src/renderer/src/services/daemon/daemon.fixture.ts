// The fixture daemon: the daemon calls and subscriptions a scripted scenario answers. A method the
// scenario scripts no reply for rejects with a named error rather than resolving `undefined`, so a
// screen is never trained to render an empty state where the live daemon would fail.

import type {
  DaemonEvent,
  DaemonEventPayload,
  DaemonMethod,
  DaemonParams,
  DaemonResult,
  DaemonSubscribeParams,
} from "@ai-sidekicks/contracts/daemon-methods";
import type { DaemonWire, Unsubscribe } from "@shared/preload-api.js";
import type { ScenarioEngine } from "./engine.fixture.js";
import { assertScriptedReplyOnContract, resolveScriptedReply } from "./scripted-reply.fixture.js";
import { subscribeToScenario } from "./scenario-subscriptions.fixture.js";

/** The daemon namespace answered from one scenario's engine. */
export function createFixtureDaemon(scenarioEngine: ScenarioEngine): DaemonWire {
  return {
    // The scenario's untyped reply is cast to `DaemonResult<M>` here, the one place the fixture
    // claims a type. The check holds each registered method to its response schema; a method
    // the app does not call passes unchecked.
    call: async <MethodName extends DaemonMethod>(
      method: MethodName,
      params: DaemonParams<MethodName>,
    ): Promise<DaemonResult<MethodName>> =>
      assertScriptedReplyOnContract(
        method,
        await resolveScriptedReply(scenarioEngine, method, params),
      ) as DaemonResult<MethodName>,
    // A scenario plays one session from its start, so the request is taken and not read.
    subscribe: <EventName extends DaemonEvent>(
      event: EventName,
      _params: DaemonSubscribeParams<EventName>,
      handler: (payload: DaemonEventPayload<EventName>) => void,
    ): Unsubscribe =>
      // The delivery is untyped scenario data cast to `DaemonEventPayload<E>`; the app
      // parses every delivery at its own boundary, as it does the live bridge's.
      subscribeToScenario(scenarioEngine, event, (delivered) => {
        handler(delivered as DaemonEventPayload<EventName>);
      }),
  };
}
