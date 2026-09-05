import {
  RunLinkage,
  type AgentConsoleModels,
  type ChildRunLinkageRead,
} from "../../agents/index.js";
import type { SessionStore } from "../../store/index.js";
import { SubscribedRunLinkage } from "./SubscribedRunLinkage.js";

/** One acquired child-link read, with the parent run it answers for. */
export interface AcquiredLinkage {
  readonly parentRunId: string;
  readonly read: ChildRunLinkageRead;
}

/**
 * The read to render for `parentRunId`, or `undefined` for the not-checked absence.
 *
 * A pure function rather than an expression inside the body, so the rule can be
 * driven directly with an acquisition whose verdict is known — the mismatched frame
 * it exists to catch is transient in the DOM and is not observable after `act` has
 * flushed the effect that ends it.
 */
export function linkageReadFor(
  acquired: AcquiredLinkage | undefined,
  parentRunId: string,
): ChildRunLinkageRead | undefined {
  if (acquired === undefined || acquired.parentRunId !== parentRunId) {
    return undefined;
  }
  return acquired.read;
}

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
