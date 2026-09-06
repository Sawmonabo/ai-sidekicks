import { type AgentConsoleModels } from "../../run-console/agent-console-model.js";
import type { ConsoleBridge } from "../../../bridge/index.js";
import { usePeerInvocationProjection, type SessionStore } from "../../../store/index.js";
import { PeerInvocationControl } from "./PeerInvocationControl.js";

/** The mounted arm, where a store exists and its partition subscription may run. */
export function SubscribedPeerInvocation(props: {
  readonly models: AgentConsoleModels | undefined;
  readonly bridge: ConsoleBridge | undefined;
  readonly sessionStore: SessionStore;
}): React.JSX.Element {
  const projection = usePeerInvocationProjection(props.sessionStore);
  return (
    <PeerInvocationControl
      models={props.models}
      bridge={props.bridge}
      sessionStore={props.sessionStore}
      projection={projection}
    />
  );
}
