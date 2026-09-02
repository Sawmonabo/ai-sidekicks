// What every growth operation TAKES and GIVES BACK: the signature table.
//
// This is the half of the port that changes when a wire is registered. A row landing
// adds an operation here — a request shape, a reply shape, sometimes a new named
// value beside them — and the two producers next door in `growth-port.ts` do not
// move: the mapped type derives one method per operation from this table, and the
// refusing port's body is one line per id. Lanes appending to one file grew it past
// the ~400-line rule `apps/desktop/AGENTS.md` sets, and the seam that growth was
// crossing is exactly this one — WHAT an operation is, against HOW the port is built
// from it.
//
// WHAT IS NOT HERE. The mapped type, the refusal builder, and the refusing port
// (`growth-port.ts`), because those are one construction over whatever this table
// says. What a call ANSWERS with (`growth-outcome.ts`), because a surface narrowing
// a result should not have to reach for the table it will never read. And the named
// reply values (`growth-values.ts`), because several have readers this table does
// not — the fixture port constructs one and the family barrel publishes it — and a
// table interrupted by the declarations of the things it refers to stops reading as
// a table.
//
// The request and value types are the CONSOLE's, derived from what its surfaces
// need — not a claim about the eventual wire shape, which belongs to the owning
// document named on the operation's slate row. Where a shape is genuinely unknown to
// the console it is stated as a named empty request rather than `unknown`, so a
// caller that starts passing something has to come here and say what.

import type { HydratedSessionEvent } from "@ai-sidekicks/contracts";

import type { AttentionProjection } from "./attention-projection.js";
import type { GrowthStream } from "./growth-outcome.js";
import type { SidekickDefinition, SidekickDefinitionDraft } from "./sidekick-definition.js";
import type {
  GrowthArtifactSummary,
  GrowthAttachmentIngestCompletion,
  GrowthAttentionPreference,
  GrowthBranchContext,
  GrowthBudgetState,
  GrowthCallbackTool,
  GrowthCostReceipt,
  GrowthHealthReading,
  GrowthImportProgress,
  GrowthInviteSummary,
  GrowthNavigationState,
  GrowthPaneError,
  GrowthPrPreparationState,
  GrowthSessionSummary,
  GrowthTerminalChunk,
  GrowthToolCall,
} from "./growth-values.js";
import type { SessionSnapshot } from "../store/index.js";
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

export interface GrowthOperationSignatures {
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
  // The three members `AttachmentIngestChunkRequest` registers, spelled the way it
  // spells them. `sequenceNumber` is 0-based and strictly consecutive, and `chunk` is
  // the RFC 4648 §4 base64 of at most one chunk cap of RAW bytes — the wire is JSON
  // with no binary serialization, so a payload byte reaches the daemon encoded or it
  // does not reach it at all. An offset is not among them: the daemon appends in
  // sequence order and keeps the spooled count itself.
  artifactIngestWriteChunk: {
    request: {
      readonly ingestId: string;
      readonly sequenceNumber: number;
      readonly chunk: string;
    };
    value: void;
  };
  artifactIngestComplete: {
    request: { readonly ingestId: string };
    value: GrowthAttachmentIngestCompletion;
  };
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
  // identity
  //
  // The value is the identifier and nothing else, which is the whole of what is
  // missing. A session's participant roster already carries every member's role, and
  // the store partitions by participant, so a `role` member here would be a second
  // source of truth for a fact another partition owns — and the two could disagree
  // with nothing able to say which was right (`store/entities.ts`: a store never
  // caches a flag another store owns). What no registered read supplies is which
  // entry in that roster this window IS; given that, the role is a lookup.
  callerParticipantRead: {
    request: { readonly sessionId: string };
    value: { readonly participantId: string };
  };
  // The SESSION's registry, not one run's: the registered set is curated per session
  // and rides spawn, so there is no per-run narrowing to ask for. A `runId` member
  // would be a request field with no caller, minted ahead of its reader.
  callbackToolRegistryRead: {
    request: { readonly sessionId: string };
    value: readonly GrowthCallbackTool[];
  };
  // sidekick — four of the five registered pairs, in the registry's own order. The
  // fifth is named in the slate row's own wire text: the per-session peer-invocation
  // opt-in is session state rather than a definition, and no surface on this
  // substrate sets it.
  sidekickDefinitionList: {
    // Node-local and unfiltered, so the request carries no members. Named empty
    // rather than omitted, matching the registered request half — every operation in
    // the namespace has both halves of its pair and no caller special-cases a
    // missing request type.
    request: Record<string, never>;
    value: readonly SidekickDefinition[];
  };
  sidekickDefinitionCreate: { request: SidekickDefinitionDraft; value: SidekickDefinition };
  // A partial patch over the same axes, plus the id it patches — `Partial` of the
  // draft rather than a second axis list, which would drift the first time an axis
  // landed on one and not the other. `sidekick-definition.ts` says why the draft and
  // the stored row stay two shapes while the two WRITES stay one.
  sidekickDefinitionUpdate: {
    request: { readonly definitionId: string } & Partial<SidekickDefinitionDraft>;
    // The full post-update row, so a client never reconstructs it by merging its own
    // patch — which would be a second projection of a fact the daemon just settled.
    value: SidekickDefinition;
  };
  sidekickDefinitionDelete: {
    request: { readonly definitionId: string };
    value: { readonly deleted: true };
  };
  // event content
  //
  // The one operation whose value is a type `packages/contracts` already exports
  // rather than a shape derived here. That is not a shortcut: the projection is
  // deliberately a PAIR — a byte-identical event beside a closed two-arm `content`
  // union — and a console shape that flattened the body into the event would be the
  // splice the registered type exists to prevent, since the payload schemas are
  // strict and the signature covers their bytes. So the console reads the registered
  // projection or it reads nothing.
  //
  // The request is keyed by event rather than by cursor range: a ledger row opens the
  // body it is about to render, and a range read would be a batching decision made
  // ahead of the surface that would need it.
  hydratedEventRead: {
    request: { readonly sessionId: string; readonly eventId: string };
    value: HydratedSessionEvent;
  };
  // session cost
  //
  // Two reads of one fold, and the receipt carries the budget state rather than
  // restating its figures, so the decomposition and the enforced number are the same
  // value and cannot drift. A surface that wants only the total calls
  // `orchestrationBudgetRead`; one that wants the breakdown calls
  // `orchestrationCostReceiptRead` and finds the total inside it.
  orchestrationCostReceiptRead: {
    request: { readonly sessionId: string };
    value: GrowthCostReceipt;
  };
  orchestrationBudgetRead: { request: { readonly sessionId: string }; value: GrowthBudgetState };
}
