// What every authoring act is handed, and the one record they all write. It sits below the act
// modules and the coordinator so every import edge runs one way; a shared shape held on the
// coordinator would make each act import its own importer, a cycle.
import type { PlatformBridge } from "@renderer/services/platform/platform-bridge.js";
import type {
  WorkflowDefinitionCreateBody,
  WorkflowVersionBody,
} from "@renderer/services/wire-shapes/workflow-definition-body.js";
import { normalizeWireRejection } from "@renderer/lib/wire-rejection.js";
import type { GenerationLatch } from "@renderer/lib/reads/generation-latch.js";
import type { SubjectScopedPublish } from "@renderer/lib/subject-scoped/subject-scoped-holder.js";
import {
  WORKFLOW_DETAIL_ORIGIN,
  type WorkflowDetailAct,
  type WorkflowDetailActOutcome,
} from "./definition-authoring.js";

/** Both outcomes and the exported bytes, held together so one never erases another's. */
export interface AuthoringState {
  readonly outcomes: Readonly<Record<WorkflowDetailAct, WorkflowDetailActOutcome>>;
  readonly exportedFile: string | undefined;
}

/**
 * The call that creates one definition version.
 *
 * Pass a stable function: a new identity clears the held outcomes and the single-flight
 * record, because the authoring hook holds both against the call.
 */
export type WorkflowDefinitionCreateCall = (request: WorkflowDefinitionCreateBody) => Promise<{
  readonly definitionId: string;
  readonly versionNumber: number;
  readonly contentHash?: string;
  readonly workflowVersionId?: string;
  readonly createdAt: string;
}>;

/** Everything an act needs beyond the call it is about to put. */
export interface AuthoringRuntime {
  readonly latch: GenerationLatch;
  readonly createDefinition: WorkflowDefinitionCreateCall;
  readonly bridge: PlatformBridge;
  readonly sessionId: string | undefined;
  readonly body: WorkflowVersionBody;
  /** The definition this render is addressed at, in the latch's key. Never a name. */
  readonly workflowDefinitionId: string | undefined;
  readonly publish: SubjectScopedPublish<AuthoringState>;
}

const IDLE_OUTCOME: WorkflowDetailActOutcome = { kind: "idle" };

/** Nothing attempted — what a newly opened definition starts at. */
export const IDLE_STATE: AuthoringState = {
  outcomes: { export: IDLE_OUTCOME, import: IDLE_OUTCOME },
  exportedFile: undefined,
};

/**
 * One key per `(act, definition)`: the pane is re-addressed in place and the latch outlives a
 * visit, so one definition's outstanding create must not refuse another's first press. The
 * acts take separate keys so an export superseding itself abandons no create.
 */
export function actKey(act: WorkflowDetailAct, workflowDefinitionId: string | undefined): string {
  return `${act}:${workflowDefinitionId ?? ""}`;
}

/**
 * Write one act's outcome into the state this render is addressed at. It publishes with the
 * function form so one act's settlement never erases the other act's outcome.
 */
export function publishOutcome(
  runtime: AuthoringRuntime,
  act: WorkflowDetailAct,
  outcome: WorkflowDetailActOutcome,
): void {
  runtime.publish((previous) => ({
    ...previous,
    outcomes: { ...previous.outcomes, [act]: outcome },
  }));
}

/**
 * Publish the refusal for a file-form codec that did not arrive. One sentence serves both acts
 * because the reader and writer are one lazily fetched module, so they fail together.
 */
export function publishCodecUnavailable(
  runtime: AuthoringRuntime,
  act: WorkflowDetailAct,
  rejection: unknown,
): void {
  publishOutcome(runtime, act, {
    kind: "refused",
    refusal: normalizeWireRejection(WORKFLOW_DETAIL_ORIGIN, rejection, {
      code: "call-rejected",
      detail:
        "The part of this app that reads and writes definition files did not load, so nothing happened. Pressing again asks for it once more.",
    }),
  });
}
