// The growth port: the console's single fixture-only seam.
//
// `Plan-023 §Console growth slate` names twenty-seven wires the console builds
// against and does not yet have. Those rows are not methods — one bundles a whole
// namespace plus two settings plus a pane-kind declaration, several describe type
// semantics on replies that already exist. So the port is keyed by OPERATION, not
// by row, and the ledger that records the keying is two tables next door:
// `GROWTH_OPERATIONS` (`growth-operations.ts`) for the callables and
// `GROWTH_PREREQUISITES` (`growth-prerequisites.ts`) for the non-callable rest.
//
// I-023-13's test maps in both directions: no slate row is unmapped, no entry names
// a row that is not on the slate, and every entry's live-status agrees with its
// row. There is deliberately no dispatcher collapsing unrelated operations into one
// call — a single `invoke(name, payload)` would type-erase every one of these and
// make the fixture's shape identity unverifiable, which is the one property the
// port exists to keep.
//
// The live bridge implements every method as a typed refusal. That refusal renders
// as the "not checked" kind of nothing (`Spec-023 §Console Design (Meridian)` §The
// five kinds of nothing), never as an empty list — because "we have not asked" and
// "there is none" are different facts and the console does not conflate them.
//
// WHAT THIS FILE OWNS, AND WHY THE LINE IS HERE. Everything that makes the port
// CALLABLE: what each operation takes, what it gives back, the mapped type that
// derives one method per operation, and the two functions that produce a port
// value. The ledger's rows and the ledger's row shape are somebody else's — they
// change when a wire lands, and this file does not. What a call ANSWERS with is
// `growth-outcome.ts`, so a surface can narrow a result without reaching for the
// signature table it will never read.

import { refuse } from "../core/index.js";
import type { SessionSnapshot } from "../store/index.js";
import type { AttentionProjection } from "./attention-projection.js";
import type { GrowthOperationId } from "./growth-entry.js";
import { GROWTH_OPERATIONS } from "./growth-operations.js";
import {
  GROWTH_PORT_REFUSAL_ORIGIN,
  type GrowthOutcome,
  type GrowthPortRefusalCode,
  type GrowthStream,
  type GrowthUnavailable,
} from "./growth-outcome.js";
import { growthSlateRow } from "./growth-slate.js";
import type {
  WorkflowDefinitionScope,
  WorkflowDefinitionSummary,
  WorkflowGateState,
  WorkflowPhaseOutput,
  WorkflowPhaseRunState,
  WorkflowPhaseState,
  WorkflowRunSnapshot,
  WorkflowRunState,
} from "./workflow-projection.js";

// --- Operation signatures -------------------------------------------------
//
// One typed entry per operation. The request and value types are the CONSOLE's,
// derived from what its surfaces need — not a claim about the eventual wire shape,
// which belongs to the owning document. Where a shape is genuinely unknown to the
// console it is stated as a named empty request rather than `unknown`, so a caller
// that starts passing something has to come here and say what.

export interface GrowthNavigationState {
  readonly url: string;
  readonly title: string;
  readonly isLoading: boolean;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
}

export interface GrowthToolCall {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly argumentsJson: string;
}

export interface GrowthTerminalChunk {
  readonly terminalId: string;
  readonly data: string;
}

export interface GrowthArtifactSummary {
  readonly artifactId: string;
  readonly name: string;
  readonly byteLength: number;
  readonly contentType: string;
}

export interface GrowthSessionSummary {
  readonly sessionId: string;
  /**
   * Optional because a session may genuinely have no name, and
   * `Spec-023 §Console Design (Meridian)` says what happens then: it renders by its
   * identifier, never by an invented title. A required member would force every
   * producer to supply one, and the only value a producer without a title can
   * supply is a fabrication.
   */
  readonly title?: string;
  readonly state: string;
}

export interface GrowthInviteSummary {
  readonly inviteId: string;
  readonly state: string;
  readonly expiresAt: string;
}

export interface GrowthHealthReading {
  readonly component: string;
  readonly state: string;
  readonly observedAt: string;
}

export interface GrowthPaneError {
  readonly paneId: string;
  readonly reason: string;
}

export interface GrowthImportProgress {
  readonly importId: string;
  readonly turnsSeen: number;
  readonly state: string;
}

/**
 * One notification preference, as both the read reply and the update request carry it.
 *
 * `Spec-019 §Interfaces And Contracts` requires the preference pair to "support
 * per-surface preferences", and `Spec-019 §Resolved Questions and V1 Scope Decisions`
 * scopes the store itself to global-per-participant in V1 — so the console's shape is
 * an opaque keyed value rather than an enumeration of surfaces, and stays that way
 * until a document names the keys. Read and update share one declaration because they
 * are the two sides of one record: two copies would let the reply and the request
 * disagree about what a preference IS, which is a disagreement nothing here can catch.
 */
export interface GrowthAttentionPreference {
  readonly key: string;
  readonly value: Readonly<Record<string, unknown>>;
}

// gitflow

/**
 * A writable run's branch context, as `Spec-011 §Interfaces And Contracts`
 * requires the read to expose it — base, head, upstream, and worktree association.
 *
 * The three optional members are optional on the wire for structural reasons, not
 * for convenience, and the reasons are worth carrying: `upstreamRef` is absent
 * until the head branch has one, and `worktreeId` / `ephemeralCloneId` are present
 * only on the anchoring their context actually has (`branch_contexts` carries an
 * at-most-one association CHECK). A required member here would force a producer to
 * supply a value for an anchoring the context does not have, and the only value it
 * could supply is a fabrication.
 */
export interface GrowthBranchContext {
  readonly branchContextId: string;
  readonly workspaceId: string;
  readonly baseBranch: string;
  readonly headBranch: string;
  readonly upstreamRef?: string;
  readonly worktreeId?: string;
  readonly ephemeralCloneId?: string;
}

/**
 * The states a prepared pull request is in. Closed, declared once, derived below.
 *
 * `Spec-011 §Required Behavior` makes PR preparation reviewable BEFORE any remote
 * mutation, and these two are what that review is between: a proposal still being
 * assembled and one a person may send. Neither names a remote state — nothing here
 * has talked to a git host.
 */
export const GROWTH_PR_PREPARATION_STATES = ["draft", "ready"] as const;

/** One prepared-pull-request state. Derived, so the vocabulary has one home. */
export type GrowthPrPreparationState = (typeof GROWTH_PR_PREPARATION_STATES)[number];

interface GrowthOperationSignatures {
  browserNavigate: { request: { readonly paneId: string; readonly url: string }; value: void };
  browserReload: { request: { readonly paneId: string }; value: void };
  browserStopLoading: { request: { readonly paneId: string }; value: void };
  browserGoBack: { request: { readonly paneId: string }; value: void };
  browserGoForward: { request: { readonly paneId: string }; value: void };
  browserSubscribeNavigation: {
    request: { readonly paneId: string };
    value: GrowthStream<GrowthNavigationState>;
  };
  browserSubscribeToolCalls: {
    request: { readonly sessionId: string };
    value: GrowthStream<GrowthToolCall>;
  };
  browserRespondToToolCall: {
    request: { readonly toolCallId: string; readonly resultJson: string };
    value: void;
  };
  terminalSubscribeOutput: {
    request: { readonly terminalId: string };
    value: GrowthStream<GrowthTerminalChunk>;
  };
  terminalWrite: { request: { readonly terminalId: string; readonly data: string }; value: void };
  terminalResize: {
    request: { readonly terminalId: string; readonly columns: number; readonly rows: number };
    value: void;
  };
  terminalAcquireWriteLease: {
    request: { readonly terminalId: string };
    value: { readonly granted: boolean };
  };
  terminalReleaseWriteLease: { request: { readonly terminalId: string }; value: void };
  devServerProbe: { request: { readonly port: number }; value: { readonly listening: boolean } };
  sessionRename: { request: { readonly sessionId: string; readonly title: string }; value: void };
  sessionArchive: { request: { readonly sessionId: string }; value: void };
  sessionClose: { request: { readonly sessionId: string }; value: void };
  sessionReactivate: { request: { readonly sessionId: string }; value: void };
  sessionRead: { request: { readonly sessionId: string }; value: SessionSnapshot };
  sessionList: { request: Record<string, never>; value: readonly GrowthSessionSummary[] };
  daemonStatusRead: {
    request: Record<string, never>;
    value: { readonly state: string; readonly version: string };
  };
  daemonStop: { request: Record<string, never>; value: void };
  daemonRestart: { request: Record<string, never>; value: void };
  onboardingStateRead: {
    request: Record<string, never>;
    value: { readonly completedStepIds: readonly string[]; readonly isComplete: boolean };
  };
  onboardingStepAdvance: { request: { readonly stepId: string }; value: void };
  onboardingStepSkip: { request: { readonly stepId: string }; value: void };
  onboardingComplete: { request: Record<string, never>; value: void };
  onboardingProviderSignInHandoff: { request: { readonly providerName: string }; value: void };
  shellConfigRead: { request: Record<string, never>; value: Readonly<Record<string, boolean>> };
  shellConfigWrite: { request: { readonly key: string; readonly enabled: boolean }; value: void };
  invitesList: { request: { readonly sessionId: string }; value: readonly GrowthInviteSummary[] };
  healthSubscribe: { request: Record<string, never>; value: GrowthStream<GrowthHealthReading> };
  gitActionExecute: {
    request: { readonly workspaceId: string; readonly action: string };
    value: { readonly accepted: boolean };
  };
  artifactIngestBegin: {
    request: { readonly sessionId: string; readonly name: string; readonly byteLength: number };
    value: { readonly ingestId: string };
  };
  artifactIngestWriteChunk: {
    request: { readonly ingestId: string; readonly offset: number; readonly byteLength: number };
    value: void;
  };
  artifactIngestComplete: { request: { readonly ingestId: string }; value: GrowthArtifactSummary };
  artifactList: {
    request: { readonly sessionId: string };
    value: readonly GrowthArtifactSummary[];
  };
  artifactRead: { request: { readonly artifactId: string }; value: GrowthArtifactSummary };
  artifactDelete: { request: { readonly artifactId: string }; value: void };
  artifactAllowlistRead: {
    request: { readonly sessionId: string };
    value: { readonly contentTypes: readonly string[]; readonly maximumByteLength: number };
  };
  artifactIngestAbort: { request: { readonly ingestId: string }; value: void };
  sessionSearch: { request: { readonly query: string }; value: readonly GrowthSessionSummary[] };
  windowDetachPane: { request: { readonly paneId: string }; value: { readonly windowId: string } };
  windowFocusAuxiliary: { request: { readonly windowId: string }; value: void };
  windowCloseAuxiliary: { request: { readonly windowId: string }; value: void };
  windowSubscribePaneErrors: {
    request: Record<string, never>;
    value: GrowthStream<GrowthPaneError>;
  };
  providerSessionImportBegin: {
    request: { readonly providerName: string; readonly sourceRef: string };
    value: { readonly importId: string };
  };
  providerSessionImportSubscribe: {
    request: { readonly importId: string };
    value: GrowthStream<GrowthImportProgress>;
  };
  // The registered request also carries a `scope` / `runId` narrowing pair. It is
  // deliberately absent here: the console reads a session's whole projection — the
  // run-scoped items and the session aggregate arrive together and are told apart by
  // the presence of `runId` on each item — so a narrowing member would be a request
  // field with no caller, minted ahead of its reader.
  attentionProjectionRead: { request: { readonly sessionId: string }; value: AttentionProjection };
  attentionPreferenceRead: {
    request: { readonly participantId: string };
    value: { readonly preferences: readonly GrowthAttentionPreference[] };
  };
  attentionPreferenceUpdate: {
    request: GrowthAttentionPreference & { readonly participantId: string };
    value: { readonly updatedAt: string };
  };
  // workflow. Every state below is `Extract`ed from the vocabulary
  // `workflow-projection.ts` declares rather than spelled again: four of these
  // replies answer with a SUBSET of a union that module owns, and a re-spelled
  // subset is how the two come apart on the day a value is renamed.
  workflowDefinitionList: {
    request: {
      readonly sessionId: string;
      /** Omitted for the resolved union of every visible scope. */
      readonly scope?: WorkflowDefinitionScope;
      readonly limit?: number;
      readonly cursor?: string;
    };
    value: {
      readonly definitions: readonly WorkflowDefinitionSummary[];
      readonly nextCursor?: string;
    };
  };
  workflowRunStart: {
    request: {
      readonly workflowVersionId: string;
      readonly sessionId: string;
      /** The originating channel of a chat-borne start. Absent elsewhere. */
      readonly channelId?: string;
    };
    value: {
      readonly workflowRunId: string;
      readonly state: Extract<WorkflowRunState, "pending" | "running">;
      readonly phaseStates: readonly WorkflowPhaseState[];
    };
  };
  workflowRunRead: { request: { readonly workflowRunId: string }; value: WorkflowRunSnapshot };
  workflowRunCancel: {
    request: { readonly workflowRunId: string; readonly reason?: string };
    value: {
      readonly workflowRunId: string;
      // One value rather than the whole run union: a successful cancel has exactly
      // one outcome, and a run that already reached a terminal state refuses.
      readonly state: Extract<WorkflowRunState, "cancelled">;
      readonly cancelledEventId: string;
      /** True when the run was already cancelled and this call replayed the first. */
      readonly alreadyCancelled: boolean;
    };
  };
  workflowRunResume: {
    request: {
      readonly workflowRunId: string;
      /** Present only to request the explicit re-pin; an ordinary resume omits it. */
      readonly versionRepin?: { readonly targetWorkflowVersionId: string };
    };
    value: {
      readonly workflowRunId: string;
      // `suspended` is a legal outcome and not a refusal: a resume that reaches a
      // provider still refusing re-parks, and the re-park is what the operator sees.
      readonly state: Extract<WorkflowRunState, "running" | "suspended">;
      readonly repinnedFromWorkflowVersionId?: string;
      readonly repinnedToWorkflowVersionId?: string;
    };
  };
  workflowPhaseOutputRead: {
    request: { readonly workflowRunId: string; readonly phaseId: string };
    value: {
      readonly phaseId: string;
      // The PHASE-run union, not the run union — both carry these two values and
      // only one of them is what an output read is reporting on.
      readonly state: Extract<WorkflowPhaseRunState, "completed" | "failed">;
      readonly outputs: readonly WorkflowPhaseOutput[];
    };
  };
  workflowGateResolve: {
    request: {
      readonly workflowRunId: string;
      readonly phaseId: string;
      readonly resolution: "passed" | "failed" | "waiting-human";
      readonly feedback?: string;
    };
    value: {
      readonly phaseId: string;
      readonly gateState: Extract<WorkflowGateState, "open" | "closed">;
      readonly nextPhaseId?: string;
      // The two halves of one anchor: a daemon at this contract revision emits both
      // together, and an older one emits neither. Never one without the other.
      readonly gateResolutionId?: string;
      readonly rowHash?: string;
    };
  };
  workflowHumanFormSubmit: {
    request: {
      readonly workflowRunId: string;
      readonly phaseId: string;
      readonly fields: Readonly<Record<string, unknown>>;
      readonly attachmentArtifactIds?: readonly string[];
      /** The optimistic-concurrency token read off the phase's `formRevision`. */
      readonly expectedRevision: number;
    };
    value: {
      readonly phaseId: string;
      readonly phaseRunId: string;
      readonly outputCount: number;
      readonly submittedAt: string;
    };
  };
  workflowGateChainVerify: {
    request: { readonly workflowRunId: string };
    value: {
      readonly workflowRunId: string;
      readonly verified: boolean;
      readonly rowsChecked: number;
      // Both present only on a failed verification, which reports the FIRST
      // divergence rather than a bare pass-or-fail.
      readonly firstDivergentSequence?: number;
      readonly divergence?:
        | "row_hash_mismatch"
        | "sequence_gap"
        | "missing_event_anchor"
        | "signature_invalid";
    };
  };
  // gitflow
  //
  // The registered request is one of two arms — a `branchContextId`, or a
  // `worktreeId` paired with the `workspaceId` that makes it a key. Only the
  // second is here, because the console holds no `BranchContextId` to ask with:
  // that id is minted by `repo.executionRootPrepare`, a wire the console does not
  // have and no growth row carries, so an arm keyed on it would be a request shape
  // with no caller. The context id travels the other way, on the reply, which is
  // where the proposal gate below gets the one it sends.
  //
  // The value is an ENVELOPE rather than a bare context, so "this workspace has no
  // branch context" is a served answer rather than an absent one. The two facts a
  // repos surface has to tell apart are "nobody asked" (the port's refusal) and
  // "we asked and there is none", and a bare optional value would have collapsed
  // the second into the shape of the first.
  gitflowBranchContextRead: {
    request: { readonly workspaceId: string; readonly worktreeId: string };
    value: { readonly branchContext: GrowthBranchContext | undefined };
  };
  gitflowPrPrepare: {
    request: {
      readonly branchContextId: string;
      readonly targetBranch: string;
      readonly title?: string;
      readonly description?: string;
    };
    value: {
      readonly prPreparationId: string;
      readonly state: GrowthPrPreparationState;
      readonly proposalBlob: Readonly<Record<string, unknown>>;
    };
  };
}

/**
 * The port. One method per operation, derived from the signature table so the
 * compiler keeps the three declarations — id union, metadata record, signature
 * table — in agreement.
 */
export type GrowthPort = {
  readonly [OperationId in GrowthOperationId]: (
    request: GrowthOperationSignatures[OperationId]["request"],
  ) => Promise<GrowthOutcome<GrowthOperationSignatures[OperationId]["value"]>>;
};

/**
 * Build the refusal one operation returns when its wire is not registered.
 *
 * Routed through `core`'s `refuse` so the field order and the `origin` vocabulary
 * stay uniform across the console; the spread re-narrows `code`, which `refuse`'s
 * deliberately-`string` parameter widens away.
 */
export function growthUnavailable(operationId: GrowthOperationId): GrowthUnavailable {
  const entry = GROWTH_OPERATIONS[operationId];
  const row = growthSlateRow(entry.slateRow);
  // Bound once, then read twice. `refuse` takes `code` as a `string` and the spread
  // has to re-narrow it, so the value is needed in two positions — and two
  // independent literals could drift apart with nothing to catch it, since one feeds
  // a `string` parameter that accepts anything. One binding makes them the same
  // value by construction, and the annotation holds it inside the closed vocabulary
  // `GROWTH_PORT_REFUSAL_CODES` declares.
  const code: GrowthPortRefusalCode = "wire-unregistered";
  return {
    ...refuse(
      GROWTH_PORT_REFUSAL_ORIGIN,
      code,
      `Not checked — ${row.wire} is not registered yet (${row.owningDocument} owns it).`,
    ),
    code,
    status: "unavailable",
    operationId,
    slateRow: entry.slateRow,
    owningDocument: row.owningDocument,
  };
}

/**
 * The live bridge's growth port: every operation refuses.
 *
 * Written out rather than generated from `GROWTH_OPERATIONS`, because the return
 * type is per-operation and a generated object would need a cast that switches off
 * exactly the checking this table exists to provide. The `GrowthPort` annotation
 * makes a missing method a compile error.
 */
export function createRefusingGrowthPort(): GrowthPort {
  return {
    browserNavigate: async () => growthUnavailable("browserNavigate"),
    browserReload: async () => growthUnavailable("browserReload"),
    browserStopLoading: async () => growthUnavailable("browserStopLoading"),
    browserGoBack: async () => growthUnavailable("browserGoBack"),
    browserGoForward: async () => growthUnavailable("browserGoForward"),
    browserSubscribeNavigation: async () => growthUnavailable("browserSubscribeNavigation"),
    browserSubscribeToolCalls: async () => growthUnavailable("browserSubscribeToolCalls"),
    browserRespondToToolCall: async () => growthUnavailable("browserRespondToToolCall"),
    terminalSubscribeOutput: async () => growthUnavailable("terminalSubscribeOutput"),
    terminalWrite: async () => growthUnavailable("terminalWrite"),
    terminalResize: async () => growthUnavailable("terminalResize"),
    terminalAcquireWriteLease: async () => growthUnavailable("terminalAcquireWriteLease"),
    terminalReleaseWriteLease: async () => growthUnavailable("terminalReleaseWriteLease"),
    devServerProbe: async () => growthUnavailable("devServerProbe"),
    sessionRename: async () => growthUnavailable("sessionRename"),
    sessionArchive: async () => growthUnavailable("sessionArchive"),
    sessionClose: async () => growthUnavailable("sessionClose"),
    sessionReactivate: async () => growthUnavailable("sessionReactivate"),
    sessionRead: async () => growthUnavailable("sessionRead"),
    sessionList: async () => growthUnavailable("sessionList"),
    daemonStatusRead: async () => growthUnavailable("daemonStatusRead"),
    daemonStop: async () => growthUnavailable("daemonStop"),
    daemonRestart: async () => growthUnavailable("daemonRestart"),
    onboardingStateRead: async () => growthUnavailable("onboardingStateRead"),
    onboardingStepAdvance: async () => growthUnavailable("onboardingStepAdvance"),
    onboardingStepSkip: async () => growthUnavailable("onboardingStepSkip"),
    onboardingComplete: async () => growthUnavailable("onboardingComplete"),
    onboardingProviderSignInHandoff: async () =>
      growthUnavailable("onboardingProviderSignInHandoff"),
    shellConfigRead: async () => growthUnavailable("shellConfigRead"),
    shellConfigWrite: async () => growthUnavailable("shellConfigWrite"),
    invitesList: async () => growthUnavailable("invitesList"),
    healthSubscribe: async () => growthUnavailable("healthSubscribe"),
    gitActionExecute: async () => growthUnavailable("gitActionExecute"),
    artifactIngestBegin: async () => growthUnavailable("artifactIngestBegin"),
    artifactIngestWriteChunk: async () => growthUnavailable("artifactIngestWriteChunk"),
    artifactIngestComplete: async () => growthUnavailable("artifactIngestComplete"),
    artifactList: async () => growthUnavailable("artifactList"),
    artifactRead: async () => growthUnavailable("artifactRead"),
    artifactDelete: async () => growthUnavailable("artifactDelete"),
    artifactAllowlistRead: async () => growthUnavailable("artifactAllowlistRead"),
    artifactIngestAbort: async () => growthUnavailable("artifactIngestAbort"),
    sessionSearch: async () => growthUnavailable("sessionSearch"),
    windowDetachPane: async () => growthUnavailable("windowDetachPane"),
    windowFocusAuxiliary: async () => growthUnavailable("windowFocusAuxiliary"),
    windowCloseAuxiliary: async () => growthUnavailable("windowCloseAuxiliary"),
    windowSubscribePaneErrors: async () => growthUnavailable("windowSubscribePaneErrors"),
    providerSessionImportBegin: async () => growthUnavailable("providerSessionImportBegin"),
    providerSessionImportSubscribe: async () => growthUnavailable("providerSessionImportSubscribe"),
    attentionProjectionRead: async () => growthUnavailable("attentionProjectionRead"),
    attentionPreferenceRead: async () => growthUnavailable("attentionPreferenceRead"),
    attentionPreferenceUpdate: async () => growthUnavailable("attentionPreferenceUpdate"),
    // workflow
    workflowDefinitionList: async () => growthUnavailable("workflowDefinitionList"),
    workflowRunStart: async () => growthUnavailable("workflowRunStart"),
    workflowRunRead: async () => growthUnavailable("workflowRunRead"),
    workflowRunCancel: async () => growthUnavailable("workflowRunCancel"),
    workflowRunResume: async () => growthUnavailable("workflowRunResume"),
    workflowPhaseOutputRead: async () => growthUnavailable("workflowPhaseOutputRead"),
    workflowGateResolve: async () => growthUnavailable("workflowGateResolve"),
    workflowHumanFormSubmit: async () => growthUnavailable("workflowHumanFormSubmit"),
    workflowGateChainVerify: async () => growthUnavailable("workflowGateChainVerify"),
    // gitflow
    gitflowBranchContextRead: async () => growthUnavailable("gitflowBranchContextRead"),
    gitflowPrPrepare: async () => growthUnavailable("gitflowPrPrepare"),
  };
}
