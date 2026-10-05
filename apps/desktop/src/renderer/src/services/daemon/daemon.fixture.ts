// The fixture daemon: the daemon calls and subscriptions a scripted scenario answers. A method the
// scenario scripts no reply for rejects with a named error rather than resolving `undefined`, so a
// screen is never trained to render an empty state where the live daemon would fail. A scenario's
// daemon always answers, so the status topic reads connected from its first delivery.

import type {
  DaemonMethod,
  DaemonParams,
  DaemonResult,
} from "@ai-sidekicks/contracts/daemon/methods";
import { DAEMON_STATUS_TOPIC, type MainProcessState } from "@shared/daemon-status-topic.js";
import type {
  DaemonWire,
  DaemonWirePayload,
  DaemonWireRequest,
  DaemonWireTopic,
  ServedDaemonCall,
  Unsubscribe,
} from "@shared/preload-api.js";
import type { ScenarioEngine } from "./engine.fixture.js";
import { assertScriptedReplyOnContract, resolveScriptedReply } from "./scripted-reply.fixture.js";
import { subscribeToScenario } from "./scenario-subscriptions.fixture.js";

/** The status topic's one delivery: a service this app found running, linked and answering. */
const FIXTURE_SERVICE_STATE: MainProcessState = {
  connection: { kind: "connected" },
  negotiation: undefined,
  startedByApp: false,
  whileSignedOut: undefined,
  cannotStart: undefined,
};

/** The daemon namespace answered from one scenario's engine. */
export function createFixtureDaemon(scenarioEngine: ScenarioEngine): DaemonWire {
  return {
    // The scenario's untyped reply is cast to `DaemonResult<M>` here, the one place the fixture
    // claims a type. The check holds each registered method to its response schema; a method
    // the app does not call passes unchecked.
    call: async <MethodName extends DaemonMethod>(
      method: MethodName,
      params: DaemonParams<MethodName>,
    ): Promise<ServedDaemonCall<DaemonResult<MethodName>>> => ({
      value: assertScriptedReplyOnContract(
        method,
        await resolveScriptedReply(scenarioEngine, method, params),
      ) as DaemonResult<MethodName>,
    }),
    subscribe: <Topic extends DaemonWireTopic>(
      event: Topic,
      params: DaemonWireRequest<Topic>,
      handler: (payload: DaemonWirePayload<Topic>) => void,
      onEnded?: Parameters<DaemonWire["subscribe"]>[3],
    ): Unsubscribe => {
      if (event === DAEMON_STATUS_TOPIC) {
        handler(FIXTURE_SERVICE_STATE as DaemonWirePayload<Topic>);
        return () => undefined;
      }
      // The delivery is untyped scenario data cast to the topic's payload; the app parses every
      // delivery at its own boundary, as it does the live bridge's.
      return subscribeToScenario(
        scenarioEngine,
        event,
        params,
        (delivered) => {
          handler(delivered as DaemonWirePayload<Topic>);
        },
        onEnded,
      );
    },
    requestStart: async () => {
      // A scenario's daemon always answers, so there is no service to start.
    },
  };
}
