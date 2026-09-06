// The non-callable half of the growth ledger: types, settings keys, pane-kind
// declarations, event-type registrations, error namespaces, and the documents that
// have to exist before a slate row can land.
//
// These never become port methods, because a method that dispatches nothing is a
// fiction the compiler would then let callers depend on. That is exactly why they
// are a separate table from `GROWTH_OPERATIONS` and exactly why they are a separate
// module: every operation row has a port method standing behind it, and a
// prerequisite row that drifted into that table would mint one for something no one
// can call. Two modules keep the two id sets apart at the type level: the port
// derives its method surface from `GrowthOperationId` alone, so nothing declared
// here can widen it even by accident.
//
// What these rows are FOR is the audit. `I-023-13` maps the ledger and the slate in
// both directions, and a slate row whose only unmet need is a type member would be
// unmappable without a row here, which is the same fiction from the other side: the
// row would look unserved forever.

import type {
  GrowthPrerequisiteEntry,
  GrowthPrerequisiteId,
  GrowthPrerequisiteKind,
} from "./growth-entry.js";
import type { GrowthSlateRowId } from "./growth-slate.js";

/** Every non-callable prerequisite, keyed by id. Never a port method. */
export const GROWTH_PREREQUISITES: Readonly<Record<GrowthPrerequisiteId, GrowthPrerequisiteEntry>> =
  {
    browserPaneKindDeclaration: prerequisite(
      "browserPaneKindDeclaration",
      "browser-pane-namespace",
      "pane-kind",
      "the browser member of the closed pane-kind set",
    ),
    browserNodeSettings: prerequisite(
      "browserNodeSettings",
      "browser-pane-namespace",
      "settings-key",
      "the two node-wide browser settings",
    ),
    browserCallbackToolRows: prerequisite(
      "browserCallbackToolRows",
      "browser-tool-relay",
      "tool-registration",
      "browser tool set as callback-tool rows in the session registry",
    ),
    terminalWriteLeaseObligations: prerequisite(
      "terminalWriteLeaseObligations",
      "terminal-pane",
      "type-member",
      "the renderer's obligations under the shared-terminal write lease",
    ),
    onboardingErrorCodes: prerequisite(
      "onboardingErrorCodes",
      "onboarding-methods",
      "error-namespace",
      "the first-run error codes the frame renders",
    ),
    shellConfigPreferenceKeys: prerequisite(
      "shellConfigPreferenceKeys",
      "shell-config-preferences",
      "settings-key",
      "crash-report opt-out, the two browser switches, and the auto-update toggle",
    ),
    agentSnapshotAxisMembers: prerequisite(
      "agentSnapshotAxisMembers",
      "agent-snapshot-axes",
      "type-member",
      "the four attach-time snapshot axes as optional members on the agent-list reply",
    ),
    gitActionVocabulary: prerequisite(
      "gitActionVocabulary",
      "gitflow-actions",
      "type-member",
      "the closed vocabulary of git actions the surfaces may offer",
    ),
    gitflowErrorNamespace: prerequisite(
      "gitflowErrorNamespace",
      "gitflow-actions",
      "error-namespace",
      "the gitflow error codes the surfaces render",
    ),
    worktreeSetupRecipeCarrier: prerequisite(
      "worktreeSetupRecipeCarrier",
      "worktree-setup-recipe",
      "type-member",
      "the worktree setup-recipe carrier the repos surface renders",
    ),
    workflowEventTypeRegistration: prerequisite(
      "workflowEventTypeRegistration",
      "workflow-event-registration",
      "event-type",
      "the twenty-four workflow event types the run pane projects",
    ),
    workflowDefinitionScopeMeaning: prerequisite(
      "workflowDefinitionScopeMeaning",
      "workflow-definition-scope",
      "type-member",
      "what a project-scoped workflow-definition reference means",
    ),
    timelineEpochMember: prerequisite(
      "timelineEpochMember",
      "timeline-epoch-attestation",
      "type-member",
      "the timeline read's epoch member",
    ),
    timelineRevisionAttestationMember: prerequisite(
      "timelineRevisionAttestationMember",
      "timeline-epoch-attestation",
      "type-member",
      "the timeline read's revision-attestation member",
    ),
    timelinePathReferenceMember: prerequisite(
      "timelinePathReferenceMember",
      "timeline-path-reference",
      "type-member",
      "the validated path-reference member on timeline rows",
    ),
    approvalRememberedRuleMember: prerequisite(
      "approvalRememberedRuleMember",
      "approval-remembered-rule",
      "type-member",
      "the per-row remembered-rule match on approval rows",
    ),
    approvalAmendmentArm: prerequisite(
      "approvalAmendmentArm",
      "approval-amendment-arm",
      "type-member",
      "the amendment arm on the approval decision input",
    ),
    providerSessionImportSpec: prerequisite(
      "providerSessionImportSpec",
      "provider-session-import",
      "governing-document",
      "the spec that will govern provider-session import",
    ),
  };

function prerequisite(
  id: GrowthPrerequisiteId,
  slateRow: GrowthSlateRowId,
  kind: GrowthPrerequisiteKind,
  summary: string,
): GrowthPrerequisiteEntry {
  return { id, slateRow, kind, summary, liveStatus: "fixture-only" };
}
