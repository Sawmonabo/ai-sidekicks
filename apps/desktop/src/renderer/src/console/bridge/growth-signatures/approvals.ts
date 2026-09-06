// The approval plane: the four methods the approvals pane calls.
//
// One plane of `GrowthOperationSignatures`, composed into it by `index.ts`. The
// section and row comments below are the single table's own, kept with the rows they
// explain.

import type {
  ApprovalRecord,
  ApprovalResolveRequest,
  ParsedRows,
  RememberedRule,
} from "../approvals/index.js";

export interface ApprovalGrowthSignatures {
  // approval — the four methods the approvals pane calls. The corpus REGISTERS all
  // four method strings (`api-payload-contracts.md §Approval Method-Name Registry`),
  // and `@ai-sidekicks/contracts` publishes neither half of any of their pairs — so
  // they fail the registry's second admission conjunct and are the port's, not
  // `callDaemon`'s. `approval.requestCreate` is the registry's fifth and is
  // daemon-raised, so this console holds no operation for it; `PermissionCheck` is
  // deliberately registered nowhere and is reached from nowhere here either.
  //
  // The two reads answer with rows this family has ALREADY narrowed
  // (`bridge/approvals/approval-records.ts`), not with the raw reply: the port is the
  // console's boundary onto an unregistered wire, and a surface handed an `unknown`
  // to parse would be the per-site parse the call door exists to abolish, moved one
  // seam over. `unreadableCount` rides the value for the same reason it rides the
  // parse — "the daemon returned eleven and nine were readable" is one fact.
  approvalProjectionRead: {
    // Unfiltered. The server-side `state?` / `category?` filters exist and this
    // surface passes neither: its history renders every record an unfiltered read
    // returns, and the client filters by state nowhere.
    request: { readonly sessionId: string };
    value: ParsedRows<ApprovalRecord>;
  };
  approvalResolve: {
    // Approve and reject are this one operation with a different decision. There is
    // no fourth interaction on the card and so no fourth member here.
    request: ApprovalResolveRequest;
    value: undefined;
  };
  approvalRuleList: {
    // Always read with revoked rules included — a revoked rule that vanished would
    // read as one that was never granted, which is the opposite of an audit.
    request: { readonly sessionId: string; readonly includeRevoked: boolean };
    value: ParsedRows<RememberedRule>;
  };
  approvalRuleRevoke: {
    request: { readonly ruleId: string };
    value: undefined;
  };
}
