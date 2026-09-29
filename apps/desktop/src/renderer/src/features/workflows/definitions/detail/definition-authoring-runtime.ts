// What every act of a definition's detail is handed, and the one record they all write.
//
// ITS OWN MODULE BECAUSE THE TWO ACT MODULES TAKE FROM IT AND THE COORDINATOR TAKES
// FROM BOTH. `definition-authoring-dispatch.ts` composes this runtime and hands it
// to `definition-authoring-export.ts` and `definition-authoring-port-acts.ts`. Were the
// shared shape held on the coordinator instead, each act would import its own importer
// — a cycle `no-circular` fails — so the substrate sits below all of them and every edge
// runs one way.
//
// THE HELD VALUE IS ONE RECORD AND NOT TWO, which is what `publishOutcome` is for:
// the two acts share it, so an arm composed from a closure's copy would drop the
// other — an export settling while an import refusal was on screen would erase the
// refusal.

import type { ConsoleBridge } from "@renderer/console/bridge/console-bridge.js";
import type {
  WorkflowDefinitionCreateBody,
  WorkflowVersionBody,
} from "@renderer/services/wire-shapes/workflow-definition-body.js";
import { normalizeWireRejection } from "@renderer/lib/wire-rejection.js";
import type { GenerationLatch } from "@renderer/console/store/read/generation-latch.js";
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
  readonly bridge: ConsoleBridge;
  readonly sessionId: string | undefined;
  readonly body: WorkflowVersionBody;
  /** The definition this render is addressed at, in the latch's key. Never a name. */
  readonly workflowDefinitionId: string | undefined;
  readonly publish: SubjectScopedPublish<AuthoringState>;
}

/** One act that has not been attempted. */
const IDLE_OUTCOME: WorkflowDetailActOutcome = { kind: "idle" };

/** Nothing attempted — what a newly opened definition starts at. */
export const IDLE_STATE: AuthoringState = {
  outcomes: { export: IDLE_OUTCOME, import: IDLE_OUTCOME },
  exportedFile: undefined,
};

/**
 * One key per `(act, definition)`.
 *
 * The definition is in the key because this pane is RE-ADDRESSED IN PLACE: the latch
 * outlives one definition's visit, so definition A's outstanding create must not refuse
 * definition B's first press. The two acts take separate keys for the mirror reason —
 * an export superseding its own clipboard write must abandon no create.
 */
export function actKey(act: WorkflowDetailAct, workflowDefinitionId: string | undefined): string {
  return `${act}:${workflowDefinitionId ?? ""}`;
}

/**
 * Write one act's outcome into the state this render is addressed at.
 *
 * The FUNCTION form of publish rather than a value, because the two acts share one
 * held record and a settlement composed from a closure's copy of it would drop the
 * other — an export settling while an import refusal was on screen would erase the
 * refusal.
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
 * Publish the refusal for a file-form codec that did not arrive.
 *
 * ONE SENTENCE FOR BOTH ACTS, because it is one fact: the reader and the writer are the
 * same module and it is fetched on first use, so an export and an import fail together
 * or not at all. Two spellings of it would drift the first time either was reworded.
 * That shared sentence is also why this lives here rather than on either act.
 */
export function publishCodecAbsence(
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
