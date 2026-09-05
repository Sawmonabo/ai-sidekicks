import { RunLinkage, useNewestRunIdForAgent, type AgentConsoleModels } from "../../agents/index.js";
import type { SessionStore } from "../../store/index.js";
import { ResolvedRunLinkage } from "./ResolvedRunLinkage.js";

/** The subscribed arm: the linkage is re-keyed whenever the run partition moves. */
export function SubscribedRunLinkage(props: {
  readonly models: AgentConsoleModels;
  readonly sessionStore: SessionStore;
  readonly agentId: string | undefined;
}): React.JSX.Element {
  const parentRunId = useNewestRunIdForAgent(props.sessionStore, props.agentId);
  if (parentRunId === undefined) {
    return <RunLinkage parentRunId={undefined} state={undefined} />;
  }
  return <ResolvedRunLinkage models={props.models} parentRunId={parentRunId} />;
}
