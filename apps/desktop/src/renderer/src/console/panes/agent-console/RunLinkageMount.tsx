import { RunLinkage, type AgentConsoleModels } from "../../agents/index.js";
import type { SessionStore } from "../../store/index.js";
import { SubscribedRunLinkage } from "./SubscribedRunLinkage.js";

/**
 * The child-link read for this agent's newest run.
 *
 * Mounted with whatever the pane resolved; the arms below narrow it, because hooks
 * cannot be called conditionally and every half here is legitimately absent in some
 * address the frame can produce.
 */
export function RunLinkageMount(props: {
  readonly models: AgentConsoleModels | undefined;
  readonly sessionStore: SessionStore | undefined;
  readonly agentId: string | undefined;
}): React.JSX.Element {
  const { models, sessionStore, agentId } = props;
  if (models === undefined || sessionStore === undefined) {
    return <RunLinkage parentRunId={undefined} state={undefined} />;
  }
  return <SubscribedRunLinkage models={models} sessionStore={sessionStore} agentId={agentId} />;
}
