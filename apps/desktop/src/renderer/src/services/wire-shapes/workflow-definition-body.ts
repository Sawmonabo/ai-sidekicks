// The phase-model shapes of a workflow definition's body that the Workflows screens read:
// phase records, gate types, the entry node and the tool bindings a phase references.
//
// The workflow contract describes a definition as a node document, not a phase sequence, so
// only the scope and the tool binding are imported from it. Run shapes live in
// `workflow-projection.ts`. Each vocabulary is a tuple with a derived union, so a new value is
// one edit here, and `readVocabularyMember` and `firstUnadmittedKey` narrow untyped input
// against those sets for the definition-file readers.

import type { WorkflowDefinitionScope, WorkflowToolBinding } from "@ai-sidekicks/contracts";

/** The four phase types these screens draw. */
export const WORKFLOW_PHASE_TYPES = ["single-agent", "multi-agent", "automated", "human"] as const;

/** One phase type. Derived, so the vocabulary has exactly one home. */
export type WorkflowPhaseType = (typeof WORKFLOW_PHASE_TYPES)[number];

/** The four gate types a phase's outgoing shoulder can carry. */
export const WORKFLOW_GATE_TYPES = [
  "auto-continue",
  "quality-checks",
  "human-approval",
  "done",
] as const;

/** One gate type. Derived, so the vocabulary has exactly one home. */
export type WorkflowGateType = (typeof WORKFLOW_GATE_TYPES)[number];

/** What a phase does when it fails. */
export const WORKFLOW_FAILURE_BEHAVIORS = ["retry", "go-back-to", "stop"] as const;

/** One failure behavior. Derived, so the vocabulary has exactly one home. */
export type WorkflowFailureBehavior = (typeof WORKFLOW_FAILURE_BEHAVIORS)[number];

/**
 * The parallel-join policies.
 *
 * Required exactly when a phase is a join (a `dependsOn` list of more than one id) and refused
 * otherwise. The wire and the store never default it, so an authoring form writes `fail-fast`.
 */
export const WORKFLOW_PARALLEL_JOIN_POLICIES = ["fail-fast", "all-settled", "any-success"] as const;

/** One join policy. Derived, so the vocabulary has exactly one home. */
export type WorkflowParallelJoinPolicy = (typeof WORKFLOW_PARALLEL_JOIN_POLICIES)[number];

/**
 * One phase of a definition, as the reads carry it and an authoring write submits it.
 *
 * Absent optional members are not values: `toolBindings` absent means no tool, `goBackTo`
 * absent means the failure behavior is not the reset one, `parallelJoinPolicy` is present
 * exactly on a join, and `dependsOn` is all-or-none across a definition (absent everywhere
 * means array order is the sequential chain and stored bytes stay as submitted).
 */
export interface WorkflowPhaseDefinition {
  readonly phaseId: string;
  readonly name: string;
  readonly type: WorkflowPhaseType;
  readonly gateType: WorkflowGateType;
  readonly failureBehavior: WorkflowFailureBehavior;
  readonly toolBindings?: readonly WorkflowToolBinding[];
  /** A state-reset target, not a graph edge; the cycle check would reject one. */
  readonly goBackTo?: string;
  /** The persisted spelling of the sequence edges. All-or-none across a definition. */
  readonly dependsOn?: readonly string[];
  readonly parallelJoinPolicy?: WorkflowParallelJoinPolicy;
  readonly config?: Readonly<Record<string, unknown>>;
}

/**
 * The entry node's record. A stored definition always carries one, because the daemon
 * materializes it when an authoring request omitted it.
 */
export interface WorkflowEntry {
  readonly startMode: (typeof WORKFLOW_START_MODES)[number];
}

/**
 * The start modes a stored entry record may carry.
 *
 * An imported file naming an entry the engine cannot honor is refused, and that check reads
 * this declared set.
 */
export const WORKFLOW_START_MODES = ["manual"] as const;

/**
 * One definition, as `workflow.definitionRead` answers — latest unless a version was asked for.
 *
 * An absent `workflowVersionId` is reported as a version the console cannot address; none is
 * composed from `(definitionId, versionNumber)`.
 */
export interface WorkflowDefinitionReadResult {
  readonly id: string;
  readonly name: string;
  readonly scope: WorkflowDefinitionScope;
  readonly scopeRef?: string;
  readonly versionNumber: number;
  readonly workflowVersionId?: string;
  readonly phaseDefinitions: readonly WorkflowPhaseDefinition[];
  readonly createdAt: string;
}

/**
 * One immutable version body, as `workflow.versionRead` answers.
 *
 * Every member is required: the canonical file form is a client-side serialization of exactly
 * this reply, and a missing member could not reproduce the canonical bytes or their content
 * hash. `schemaVersion` is a string because `1.0` collapses to `1` and `1.10` would collide
 * with `1.1` as a number.
 */
export interface WorkflowVersionBody {
  readonly definitionId: string;
  readonly versionNumber: number;
  readonly workflowVersionId: string;
  readonly contentHash: string;
  readonly schemaVersion: string;
  readonly name: string;
  readonly entry: WorkflowEntry;
  readonly phaseDefinitions: readonly WorkflowPhaseDefinition[];
  readonly createdAt: string;
}

/**
 * What an authoring write submits, one shape for saving, cutting a version, importing,
 * promoting and forking a `shared` definition.
 *
 * Authorization keys on `scope`, never on which act composed the request, so the target scope
 * is required and a promotion is not a flag. `parentContentHash` is copy-on-write provenance
 * outside the hashed body; it travels on the write and on no read.
 */
export interface WorkflowDefinitionCreateBody {
  readonly sessionId: string;
  readonly name: string;
  readonly scope: WorkflowDefinitionScope;
  readonly scopeRef?: string;
  readonly entry?: WorkflowEntry;
  readonly parentContentHash?: string;
  readonly phaseDefinitions: readonly WorkflowPhaseDefinition[];
}

/**
 * One member of a closed vocabulary, read off an untyped value.
 *
 * Generic over the tuple so each caller narrows to its own union rather than to `string`.
 */
export function readVocabularyMember<TMember extends string>(
  value: unknown,
  vocabulary: readonly TMember[],
): TMember | undefined {
  return typeof value === "string" && (vocabulary as readonly string[]).includes(value)
    ? (value as TMember)
    : undefined;
}

/**
 * The first key of an untyped record that the admitted set does not carry, if any.
 *
 * Readers refuse an undeclared key rather than carry it (widening a closed shape) or drop it
 * (changing what the caller submitted). Only the first is reported; the next surfaces once it
 * is gone.
 */
export function firstUnadmittedKey(
  record: Readonly<Record<string, unknown>>,
  admittedKeys: readonly string[],
): string | undefined {
  return Object.keys(record).find((key) => !admittedKeys.includes(key));
}
