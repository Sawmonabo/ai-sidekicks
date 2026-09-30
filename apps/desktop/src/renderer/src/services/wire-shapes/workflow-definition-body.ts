// The phase-model shapes of a workflow definition's body that today's Workflows screens
// read: phase records, gate types, the entry node and the tool bindings a phase references.
//
// NO CONTRACT COUNTERPART. The workflow contract in `packages/contracts` describes a
// definition as a node document, not a phase sequence, and the screens that read these
// shapes still draw phases. What the two models share (the scope, the tool binding) is
// imported from the contract, never declared here.
//
// WHY THIS IS A SIBLING OF `workflow-projection.ts` RATHER THAN MORE OF IT. That
// module declares what a RUN looks like — states, parks, gates — and it moves when
// the run shapes move. This one declares what a DEFINITION is made of: phase records,
// gate types, the entry node. The two are read by different views and change for
// different reasons, and holding them in one module took it past the size a reader
// can carry.
//
// WHY THE VOCABULARIES ARE TUPLES. Same rule the run shapes already keep: the tuple is
// the declaration and the union derives from it, so a fifth phase type is one edit
// here rather than a string a component invents. The three that a
// view renders a label for are read through a table keyed by the union, so a widened
// vocabulary is a compile error at the label rather than a blank cell. The count is
// deliberately not written down: it moved the first time a start mode needed the same
// treatment, and a number in a header is a claim nothing reads.
//
// AND THE TWO READS AT THE FOOT ARE PART OF THAT RULE RATHER THAN AN ADDITION TO IT.
// A closed declaration has two halves — the set, and how an untyped value is narrowed
// against it — and putting the second half in whichever parser needed it first is how a
// vocabulary ends up with one home and its reading with three. `readVocabularyMember`
// answers it for a MEMBER and `firstUnadmittedKey` for a record's KEYS; the file form's
// modules each read a different subset of the sets above through them.

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
 * The three-value parallel-join policy.
 *
 * Required exactly when a phase is a join — a `dependsOn` list carrying more than one
 * id — and refused on a phase that is not. The wire and the store never default it,
 * so an authoring form writes the `fail-fast` default into what it submits.
 */
export const WORKFLOW_PARALLEL_JOIN_POLICIES = ["fail-fast", "all-settled", "any-success"] as const;

/** One join policy. Derived, so the vocabulary has exactly one home. */
export type WorkflowParallelJoinPolicy = (typeof WORKFLOW_PARALLEL_JOIN_POLICIES)[number];

/**
 * One phase of a definition, as the two reads carry it and an authoring write submits it.
 *
 * The optional members are optional for one reason each and the console must not read
 * absence as a value. `toolBindings` absent means the phase references no tool;
 * `goBackTo` absent means the failure behavior is not the reset one; `dependsOn` is
 * ALL-OR-NONE across a definition, so absent everywhere means the array's own order
 * declares the sequential chain and the stored bytes stay exactly what was submitted;
 * `parallelJoinPolicy` is present exactly on a join.
 */
export interface WorkflowPhaseDefinition {
  readonly phaseId: string;
  readonly name: string;
  readonly type: WorkflowPhaseType;
  readonly gateType: WorkflowGateType;
  readonly failureBehavior: WorkflowFailureBehavior;
  readonly toolBindings?: readonly WorkflowToolBinding[];
  /** A state-reset target and NOT a graph edge; the cycle check would reject one. */
  readonly goBackTo?: string;
  /** The persisted spelling of the sequence edges. All-or-none across a definition. */
  readonly dependsOn?: readonly string[];
  readonly parallelJoinPolicy?: WorkflowParallelJoinPolicy;
  readonly config?: Readonly<Record<string, unknown>>;
}

/**
 * The entry node's record: a single-value structure and deliberately not a union.
 *
 * No `schedule`, `event` or `webhook` arm is declared at V1, so no view draws one —
 * greyed or otherwise. A stored definition always carries exactly one of these,
 * because the daemon materializes it when an authoring request omitted it.
 */
export interface WorkflowEntry {
  readonly startMode: (typeof WORKFLOW_START_MODES)[number];
}

/**
 * The start modes a stored entry record may carry, and exactly one at V1.
 *
 * A tuple for the same reason the four above are tuples, and for one more that is
 * specific to this vocabulary: an imported file stating an entry the engine cannot
 * honor is REFUSED rather than dropped, and a reader deciding that has to check a
 * declared set. Spelling `manual` beside the check would make a second start mode an
 * edit in two places, one of which nothing reports.
 */
export const WORKFLOW_START_MODES = ["manual"] as const;

/**
 * One definition, as `workflow.definitionRead` answers — latest unless a version was
 * asked for.
 *
 * The console reports an absent `workflowVersionId` as a version it cannot address
 * rather than composing one: no encoding over `(definitionId, versionNumber)` exists.
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
 * Every member below is required. That completeness is what makes export possible at
 * all — the canonical file form is a client-side serialization of exactly
 * this reply, and a body missing a member could not reproduce the canonical bytes or
 * the content hash they hash to.
 *
 * `schemaVersion` is a STRING and deliberately not a number: `1.0` collapses to `1`
 * and loses the minor, and `1.10` would collide with `1.1`.
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
 * What an authoring write submits — one shape for all five acts.
 *
 * Saving, cutting a new version, importing, promoting and forking a `shared`
 * definition are five things a person does and one thing the daemon is asked. The
 * authorization boundary keys on `scope` and never on which act composed the request,
 * which is why the target scope is a required member here and a promotion is not a
 * flag.
 *
 * `parentContentHash` is copy-on-write provenance and is NOT part of the hashed body,
 * so a branched definition and a from-scratch definition with identical bodies hash
 * alike. It travels on the write and on no read.
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
 * Generic over the tuple so each caller narrows to its OWN union rather than to
 * `string`: the vocabularies above are that many different closed sets, and one reader
 * answering `string` would push the narrowing back to every call site.
 *
 * IT LIVES BESIDE THE DECLARATIONS, which is the half of the "declared once" rule that
 * is easy to leave out. The tuples are the vocabularies' one home, so the read that
 * narrows an untyped value against one belongs with them rather than in whichever
 * parser needed it first — the file form has three modules and each reads a different
 * subset.
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
 * The other half of "declared once", asked of a record's KEYS rather than of one
 * member's value. Every shape above is closed, and a reader handed a member nobody
 * declared has exactly two dishonest options — carry it, which widens a closed
 * shape, or drop it, which changes what the caller submitted without saying so. So the
 * readers refuse, and they all refuse by asking this.
 *
 * The FIRST and not all of them: a refusal is a sentence a person acts on, and the
 * second unknown key is read once the first is gone.
 */
export function firstUnadmittedKey(
  record: Readonly<Record<string, unknown>>,
  admittedKeys: readonly string[],
): string | undefined {
  return Object.keys(record).find((key) => !admittedKeys.includes(key));
}
