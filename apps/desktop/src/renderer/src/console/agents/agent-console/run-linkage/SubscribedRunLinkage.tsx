import { RunLinkage } from "../../run-console/RunLinkage.js";
import { type AgentConsoleModels } from "../../run-console/agent-console-model.js";
import { useNewestRunIdForAgent } from "../../run-console/agent-run-linkage.js";
import type { SessionStore } from "../../../store/index.js";
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
