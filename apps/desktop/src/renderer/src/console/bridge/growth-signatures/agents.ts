// The agent plane: the four verbs that move a session's roster, and the child-run
// linkage read that makes refused delegated work visible.
//
// One plane of `GrowthOperationSignatures`, composed into it by `index.ts`. The
// section and row comments below are the single file's own, kept with the rows they
// explain.
//
// The linkage read shares this module rather than the ledger plane's because it
// shares this plane's reader: the agent console renders one parent run's children
// beside the roster entry that spawned them.

import type {
  AgentAttachReading,
  AgentAttachRequest,
  AgentConfigUpdateReading,
  AgentConfigUpdateRequest,
  AgentDetachRequest,
  AgentListRequest,
  AgentRosterReading,
  ChildRunLinkReadRequest,
  ChildRunLinkReading,
} from "../wire-shapes/index.js";

export interface AgentGrowthSignatures {
  // agent plane — the four verbs. Their shapes are `agent-plane.ts`'s, declared there
  // rather than inline for the reason that module's header gives.
  agentList: { request: AgentListRequest; value: AgentRosterReading };
  agentAttach: { request: AgentAttachRequest; value: AgentAttachReading };
  agentConfigUpdate: { request: AgentConfigUpdateRequest; value: AgentConfigUpdateReading };
  // A detach answers with nothing. `void` rather than an invented receipt: the agent
  // row's new state reaches every surface on `agent.detached`, so a reply member
  // repeating it would be a second record of one fact.
  agentDetach: { request: AgentDetachRequest; value: void };
  // orchestration — one parent run's links plus the refusal fold, which is a single
  // read and not two: a link row and a refused create answer the same question about
  // the same parent, and asking twice would let the two disagree.
  orchestrationChildRunLinkRead: {
    request: ChildRunLinkReadRequest;
    value: ChildRunLinkReading;
  };
}
