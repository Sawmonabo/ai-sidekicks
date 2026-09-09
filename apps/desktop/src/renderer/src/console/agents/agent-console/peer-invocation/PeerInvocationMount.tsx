import { type AgentConsoleModels } from "../../run-console/agent-console-model.js";
import type { ConsoleBridge } from "../../../bridge/index.js";
import { NOTHING_PROJECTED, type SessionStore } from "../../../store/index.js";
import { SubscribedPeerInvocation } from "./SubscribedPeerInvocation.js";
import { PeerInvocationControl } from "./PeerInvocationControl.js";

/** The grant's mount: subscribed where a store exists, stated where none does. */
export function PeerInvocationMount(props: {
  readonly models: AgentConsoleModels | undefined;
  readonly bridge: ConsoleBridge | undefined;
  readonly sessionStore: SessionStore | undefined;
}): React.JSX.Element {
  const { bridge, models, sessionStore } = props;
  if (sessionStore === undefined) {
    // No store means no partition to subscribe to and nothing for a re-read to
    // land in, so the control is mounted without either and its recovery answers
    // with the refusal that says so.
    return <PeerInvocationControl models={models} bridge={bridge} projection={NOTHING_PROJECTED} />;
  }
  return <SubscribedPeerInvocation models={models} bridge={bridge} sessionStore={sessionStore} />;
}
