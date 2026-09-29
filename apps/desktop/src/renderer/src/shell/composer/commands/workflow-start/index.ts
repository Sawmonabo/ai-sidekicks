// The workflow-start sub-module's door.
//
// One command root with one verb, split across the jobs it is actually made of: the
// grammar that reads its line, the enumeration both halves resolve against, the
// matcher, the dispatch the executor runs, and the candidate list. It publishes what
// its SIBLINGS in the command zone take and nothing else.
//
// The stylesheet enters here because this directory carries a door and therefore owns
// its own rules, which is the same reason the zone's own sheet enters through the
// zone's door rather than through a component.

import "@renderer/features/composer/command-list/workflow-command/workflow-command.css";

export { useWorkflowStartHandlers } from "./start-dispatch.js";
export { useWorkflowStartPrefill } from "@renderer/features/composer/command-list/workflow-command/hooks/useWorkflowStartPrefill.js";
export {
  /** @consumedBy the composer's workflow command */
  WorkflowStartCandidates,
} from "@renderer/features/composer/command-list/workflow-command/components/WorkflowStartCandidates.js";
