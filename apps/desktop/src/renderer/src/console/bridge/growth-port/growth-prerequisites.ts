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
import type { GrowthSlateRowId } from "./growth-slate-row.js";

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
    agentProviderSwitchFailedEvent: eventTypePrerequisite(
      "agentProviderSwitchFailedEvent",
      "agent-provider-switch-failure",
      "the `agent.provider_switch_failed` event, which is how a deferred switch that could not be applied reaches a client that did not issue the mutation",
      ["agent.provider_switch_failed"],
    ),
    agentProviderSwitchedEvent: eventTypePrerequisite(
      "agentProviderSwitchedEvent",
      "agent-provider-switch-terminal",
      "the `agent.provider_switched` event, which is how a switch applied at a deferred boundary reaches a client that did not issue the mutation, carrying the continuity arm and the declared losses the new binding is working under",
      ["agent.provider_switched"],
    ),
    approvalAmendmentArm: prerequisite(
      "approvalAmendmentArm",
      "approval-amendment-arm",
      "type-member",
      "the amendment arm on the approval decision input",
    ),
    // NOT an operation, and the distinction is the module header's own. A port method
    // here would be one nothing calls: the attach mount resolves a declaration off the
    // bridge it already holds, synchronously, at the moment it renders — so the missing
    // thing is a MEMBER on that bridge and not a callable the port could stand behind.
    nodeSelfDeclarationCarrier: prerequisite(
      "nodeSelfDeclarationCarrier",
      "node-self-declaration",
      "bridge-member",
      "this node's own attach declaration — identity, contract version, self-reported health, and capability set — composed in main and handed to the renderer",
    ),
    providerSessionImportSpec: prerequisite(
      "providerSessionImportSpec",
      "provider-session-import",
      "governing-document",
      "the spec that will govern provider-session import",
    ),
    timelineResumeCursorMember: prerequisite(
      "timelineResumeCursorMember",
      "session-directory-read",
      "type-member",
      "the resume-position member on the session read's request — where the console asks the stream to be picked up from, absent from the strict request schema, which carries `sessionId` alone",
    ),
    // The one entry whose row is unmet on the PRODUCING side rather than the
    // declaring one. The mount-health union carries all three verdicts today and the
    // console projects all three fail-closed; what does not exist is a daemon that can
    // report the third, or a handler that would carry any of them to a client. So the
    // row is not callable from here even in principle — there is no growth operation
    // to write, since the console reaches mount reads through the daemon method
    // registry and a second route would be a second source of truth for one read.
    mountHealthIdentityProjection: prerequisite(
      "mountHealthIdentityProjection",
      "mount-health-identity-verdict",
      "daemon-producer",
      "the daemon-side mount-health projection that derives the identity verdict, and the handler namespace that would carry a mount read to a client",
    ),
    // A member that exists on exactly one side of its own plane. The create request
    // carries `parentContentHash` — the hash of the `shared` definition an author
    // branched from — and NEITHER read reply returns it, so a definition that was
    // forked is indistinguishable on the wire from one written from scratch. The
    // detail pane therefore renders the copy-on-write provenance as a fact the wire
    // does not carry rather than as an empty field, which is what this row is for.
    workflowParentContentHashMember: prerequisite(
      "workflowParentContentHashMember",
      "workflow-definition-authoring",
      "type-member",
      "the copy-on-write parent content hash on a definition or version read reply, which only the authoring write carries today",
    ),
    // A pair of members on a reply the console already receives, and therefore not an
    // operation: the run read is registered and served, and what is missing rides it.
    // A growth operation here would mint a call for a question the run read already
    // asks, which is the second source of truth the module header forbids.
    workflowHumanFormContentMembers: prerequisite(
      "workflowHumanFormContentMembers",
      "workflow-human-form-schema",
      "type-member",
      "the prompt and the input schema of a phase parked on a person, live-scoped on the run read's phase projection, without which a waiting phase is legible and unanswerable",
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

/**
 * One `event-type` row, which carries the types it is waiting for as a value.
 *
 * A second builder rather than a fifth parameter on the one above, because the
 * pairing is the point: the `event-type` kind and a non-empty type list are one
 * claim, and a signature that let either arrive without the other would admit the
 * two shapes this table must not hold — an `event-type` row whose types no gate can
 * read, and a type list filed under a kind that is not about event types.
 */
function eventTypePrerequisite(
  id: GrowthPrerequisiteId,
  slateRow: GrowthSlateRowId,
  summary: string,
  unregisteredEventTypes: readonly [string, ...string[]],
): GrowthPrerequisiteEntry {
  return {
    ...prerequisite(id, slateRow, "event-type", summary),
    unregisteredEventTypes,
  };
}
