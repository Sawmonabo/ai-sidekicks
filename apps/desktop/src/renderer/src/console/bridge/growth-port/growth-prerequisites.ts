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
// What these rows are FOR is the audit. The shape test maps the ledger and the slate in
// both directions, and a slate row whose only unmet need is a type member would be
// unmappable without a row here, which is the same fiction from the other side: the
// row would look unserved forever.
//
// AND THE AUDIT IS THE ONLY READER, WHICH IS WHY EVERY ROW BELOW IS ANNOTATED PURE.
// `scenario-manifest.ts` is this table's one non-test consumer and is compiled out of
// a release build, so nothing a shipped console can reach reads a row here — but the
// table is built by CALLS to the two builders at the foot of this file, and a call is
// something Rollup must assume did work. Unannotated, the whole ledger was retained in
// the release entry chunk: measured 2026-09-09, 1,370 B gzip of prose about wires the
// console does not have, on the initial graph of every session. `/* @__PURE__ */` is
// the claim that each call is a value and not an act, which both builders make true by
// returning a fresh literal and touching nothing — so removing an annotation here does
// not change what the console does, it changes what a user downloads. A row added
// without one is a row that ships.

import type {
  GrowthPrerequisiteEntry,
  GrowthPrerequisiteId,
  GrowthPrerequisiteKind,
} from "./growth-entry.js";
import type { GrowthSlateRowId } from "./growth-slate-row.js";

/** Every non-callable prerequisite, keyed by id. Never a port method. */
export const GROWTH_PREREQUISITES: Readonly<Record<GrowthPrerequisiteId, GrowthPrerequisiteEntry>> =
  {
    browserPaneKindDeclaration: /* @__PURE__ */ prerequisite(
      "browserPaneKindDeclaration",
      "browser-pane-namespace",
      "pane-kind",
      "the browser member of the closed pane-kind set",
    ),
    browserNodeSettings: /* @__PURE__ */ prerequisite(
      "browserNodeSettings",
      "browser-pane-namespace",
      "settings-key",
      "the two node-wide browser settings",
    ),
    browserCallbackToolRows: /* @__PURE__ */ prerequisite(
      "browserCallbackToolRows",
      "browser-tool-relay",
      "tool-registration",
      "browser tool set as callback-tool rows in the session registry",
    ),
    terminalWriteLeaseObligations: /* @__PURE__ */ prerequisite(
      "terminalWriteLeaseObligations",
      "terminal-pane",
      "type-member",
      "the renderer's obligations under the shared-terminal write lease",
    ),
    onboardingErrorCodes: /* @__PURE__ */ prerequisite(
      "onboardingErrorCodes",
      "onboarding-methods",
      "error-namespace",
      "the first-run error codes the frame renders",
    ),
    shellConfigPreferenceKeys: /* @__PURE__ */ prerequisite(
      "shellConfigPreferenceKeys",
      "shell-config-preferences",
      "settings-key",
      "crash-report opt-out, the two browser switches, and the auto-update toggle",
    ),
    agentSnapshotAxisMembers: /* @__PURE__ */ prerequisite(
      "agentSnapshotAxisMembers",
      "agent-snapshot-axes",
      "type-member",
      "the four attach-time snapshot axes as optional members on the agent-list reply",
    ),
    gitActionVocabulary: /* @__PURE__ */ prerequisite(
      "gitActionVocabulary",
      "gitflow-actions",
      "type-member",
      "the closed vocabulary of git actions the surfaces may offer",
    ),
    gitflowErrorNamespace: /* @__PURE__ */ prerequisite(
      "gitflowErrorNamespace",
      "gitflow-actions",
      "error-namespace",
      "the gitflow error codes the surfaces render",
    ),
    worktreeSetupRecipeCarrier: /* @__PURE__ */ prerequisite(
      "worktreeSetupRecipeCarrier",
      "worktree-setup-recipe",
      "type-member",
      "the worktree setup-recipe carrier the repos surface renders",
    ),
    workflowEventTypeRegistration: /* @__PURE__ */ prerequisite(
      "workflowEventTypeRegistration",
      "workflow-event-registration",
      "event-type",
      "the twenty-four workflow event types the run pane projects",
    ),
    workflowDefinitionScopeMeaning: /* @__PURE__ */ prerequisite(
      "workflowDefinitionScopeMeaning",
      "workflow-definition-scope",
      "type-member",
      "what a project-scoped workflow-definition reference means",
    ),
    timelineEpochMember: /* @__PURE__ */ prerequisite(
      "timelineEpochMember",
      "timeline-epoch-attestation",
      "type-member",
      "the timeline read's epoch member",
    ),
    timelineRevisionAttestationMember: /* @__PURE__ */ prerequisite(
      "timelineRevisionAttestationMember",
      "timeline-epoch-attestation",
      "type-member",
      "the timeline read's revision-attestation member",
    ),
    timelinePathReferenceMember: /* @__PURE__ */ prerequisite(
      "timelinePathReferenceMember",
      "timeline-path-reference",
      "type-member",
      "the validated path-reference member on timeline rows",
    ),
    approvalRememberedRuleMember: /* @__PURE__ */ prerequisite(
      "approvalRememberedRuleMember",
      "approval-remembered-rule",
      "type-member",
      "the per-row remembered-rule match on approval rows",
    ),
    agentProviderSwitchFailedEvent: /* @__PURE__ */ eventTypePrerequisite(
      "agentProviderSwitchFailedEvent",
      "agent-provider-switch-failure",
      "the `agent.provider_switch_failed` event, which is how a deferred switch that could not be applied reaches a client that did not issue the mutation",
      ["agent.provider_switch_failed"],
    ),
    agentProviderSwitchedEvent: /* @__PURE__ */ eventTypePrerequisite(
      "agentProviderSwitchedEvent",
      "agent-provider-switch-terminal",
      "the `agent.provider_switched` event, which is how a switch applied at a deferred boundary reaches a client that did not issue the mutation, carrying the continuity arm and the declared losses the new binding is working under",
      ["agent.provider_switched"],
    ),
    approvalAmendmentArm: /* @__PURE__ */ prerequisite(
      "approvalAmendmentArm",
      "approval-amendment-arm",
      "type-member",
      "the amendment arm on the approval decision input",
    ),
    // NOT an operation, and the distinction is the module header's own. A port method
    // here would be one nothing calls: the attach mount resolves a declaration off the
    // bridge it already holds, synchronously, at the moment it renders — so the missing
    // thing is a MEMBER on that bridge and not a callable the port could stand behind.
    nodeSelfDeclarationCarrier: /* @__PURE__ */ prerequisite(
      "nodeSelfDeclarationCarrier",
      "node-self-declaration",
      "bridge-member",
      "this node's own attach declaration — identity, contract version, self-reported health, and capability set — composed in main and handed to the renderer",
    ),
    providerSessionImportSpec: /* @__PURE__ */ prerequisite(
      "providerSessionImportSpec",
      "provider-session-import",
      "governing-document",
      "the spec that will govern provider-session import",
    ),
    timelineResumeCursorMember: /* @__PURE__ */ prerequisite(
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
    mountHealthIdentityProjection: /* @__PURE__ */ prerequisite(
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
    workflowParentContentHashMember: /* @__PURE__ */ prerequisite(
      "workflowParentContentHashMember",
      "workflow-definition-authoring",
      "type-member",
      "the copy-on-write parent content hash on a definition or version read reply, which only the authoring write carries today",
    ),
    // A pair of members on a reply the console already receives, and therefore not an
    // operation: the run read is registered and served, and what is missing rides it.
    // A growth operation here would mint a call for a question the run read already
    // asks, which is the second source of truth the module header forbids.
    workflowHumanFormContentMembers: /* @__PURE__ */ prerequisite(
      "workflowHumanFormContentMembers",
      "workflow-human-form-schema",
      "type-member",
      "the prompt and the input schema of a phase parked on a person, live-scoped on the run read's phase projection, without which a waiting phase is legible and unanswerable",
    ),
  };

/**
 * One ordinary row.
 *
 * Reads nothing, writes nothing, and returns a fresh literal, which is what makes the
 * `@__PURE__` annotation on every call above true rather than merely convenient. A
 * builder that grew a side effect — a registry write, a counter, a `console` line —
 * would make every one of those annotations a lie the bundler acts on.
 */
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
