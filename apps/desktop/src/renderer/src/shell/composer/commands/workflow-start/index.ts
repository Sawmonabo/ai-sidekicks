// The workflow-start sub-module's door.
//
// One command root with one verb, split across the jobs it is actually made of: the
// grammar that reads its line, the enumeration both halves resolve against, the
// matcher, the dispatch the executor runs, and the two surfaces the composer's own
// seat mounts. It publishes what its SIBLINGS in the command zone take and nothing
// else — the send bar's zone takes the handlers, and the discovery seat takes the
// grammar, the two surfaces, and the prefill.
//
// The stylesheet enters here because this directory carries a door and therefore owns
// its own rules, which is the same reason the zone's own sheet enters through the
// zone's door rather than through a component.

import "./workflow-start.css";

export { readWorkflowCommandLine, workflowStartLineFor } from "./grammar.js";
export { useWorkflowStartHandlers } from "./start-dispatch.js";
export { useWorkflowStartPrefill } from "./prefill.js";
export { WorkflowStartCandidates } from "./WorkflowStartCandidates.js";
export { WorkflowStartPrefillConfirm } from "./WorkflowStartPrefillConfirm.js";
