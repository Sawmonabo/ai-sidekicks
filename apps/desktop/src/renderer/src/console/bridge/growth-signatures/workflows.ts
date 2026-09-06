// The workflow plane: definitions, runs, phase outputs, gates, human forms, the
// gate-chain verification that audits them, and the run enumeration none of them is.
//
// One plane of `GrowthOperationSignatures`, composed into it by `index.ts`. The
// section comment below is the file's own, kept with the rows it explains — and it
// is the reason this plane is its own module rather than the largest block of a
// longer table: every state these replies name is `Extract`ed from the vocabulary
// `workflow-projection.ts` owns, so the rows and that module move together.

import type {
  WorkflowDefinitionScope,
  WorkflowDefinitionSummary,
  WorkflowGateState,
  WorkflowPhaseOutput,
  WorkflowPhaseRunState,
  WorkflowPhaseState,
  WorkflowRunListEntry,
  WorkflowRunSnapshot,
  WorkflowRunState,
} from "../wire-shapes/index.js";

export interface WorkflowGrowthSignatures {
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
  // The run enumeration, appended after the nine registered methods because it is
  // not one of them: no workflow method enumerates runs, so this serves the
  // `workflow-run-enumeration` slate row rather than the one above it. The request
  // is keyed by session and by nothing narrower — a run list shows what a session
  // holds, and a per-definition narrowing would be a request member with no caller.
  //
  // The value is an envelope rather than a bare array, so the reply has somewhere to
  // grow a cursor the day the wire lands with one; the console synthesizes none and
  // reads none.
  workflowRunList: {
    request: { readonly sessionId: string };
    // `WorkflowRunListEntry` and not the run read's own shape: an enumeration answers
    // with runs nobody named, and the two definition facts on that entry are what let
    // a row read as something other than an opaque id. `workflow-projection.ts` says
    // why no registered read can supply them after the fact.
    value: { readonly runs: readonly WorkflowRunListEntry[] };
  };
}
