// The console's declaration of a workflow definition's own BODY — the shapes the
// definition read, the version read, and the authoring write carry.
//
// OWNER. The workflow plane owns the three operations; the typed request and reply
// shapes are registered in the payload contracts and every vocabulary below is
// transcribed from that registry rather than re-derived from prose.
//
// WHY THIS IS A SIBLING OF `workflow-projection.ts` RATHER THAN MORE OF IT. That
// module declares what a RUN looks like — states, parks, gates, the summary a picker
// ranks — and it moves when the run plane moves. This one declares what a DEFINITION
// is made of: phase records, gate types, the entry node, the tool bindings a phase
// references. The two are read by different surfaces and change for different
// reasons, and holding them in one module took it past the size a reader can carry.
//
// WHY THE VOCABULARIES ARE TUPLES. Same rule the run plane already keeps: the tuple is
// the declaration and the union derives from it, so a fifth phase type is an amendment
// to the owning document rather than a string a component invents. The three that a
// surface renders a label for are read through a table keyed by the union, so a widened
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
//
// DELETION OBLIGATION. When `packages/contracts` registers these types this module is
// DELETED and `growth-signatures/workflows.ts` imports them from the contracts
// instead — the obligation `workflow-projection.ts` states for the run plane, on the
// same two slate rows' terms.

import type { WorkflowDefinitionScope } from "./workflow-projection.js";

/**
 * The scope-qualified MCP server binding a phase's tool reference names.
 *
 * THE MCP PLANE'S SHAPE, DECLARED HERE BECAUSE THE WORKFLOW BINDING COMPOSES IT AND
 * NO CODE PACKAGE CARRIES EITHER. The payload contracts fix the union, and
 * `WorkflowToolBinding` composes it by reference rather than restating its
 * members — a flat restatement would admit the `(codex, local)` combination the union
 * rejects at the schema layer. This is the console's one home for it: the MCP
 * governance surface takes it from here when it lands rather than declaring a second.
 *
 * `local` is admissible only with `claude`, and `user` carries no `scopeRef` at all —
 * which is why this is three arms and not one shape with two optional members.
 */
export type McpServerBindingRef =
  | { readonly provider: McpBindingProvider; readonly scope: "user"; readonly serverName: string }
  | {
      readonly provider: McpBindingProvider;
      readonly scope: "project";
      readonly scopeRef: string;
      readonly serverName: string;
    }
  | {
      readonly provider: "claude";
      readonly scope: "local";
      readonly scopeRef: string;
      readonly serverName: string;
    };

/**
 * The two providers a binding names, and the three config scopes it is qualified by.
 *
 * Tuples for the reason the four phase vocabularies below are tuples: the declaration
 * has one home and every reader derives from it, so the parser that narrows pasted text
 * checks the set that DECLARES the members rather than a literal spelled beside the
 * check. The ARMS above are still written out, because which provider goes with which
 * scope is the union's own shape rather than a third vocabulary — `local` is admissible
 * only with `claude`, and `user` carries no `scopeRef` at all.
 */
export const MCP_BINDING_PROVIDERS = ["claude", "codex"] as const;

/** One binding provider. Derived, so the vocabulary has exactly one home. */
export type McpBindingProvider = (typeof MCP_BINDING_PROVIDERS)[number];

/** The three config scopes, in the owning contract's own order. */
export const MCP_BINDING_SCOPES = ["user", "project", "local"] as const;

/**
 * A phase's tool binding: a REFERENCE, and never a policy.
 *
 * Two members and exactly two. It carries no `enabled`, no `approvalMode` and no
 * `idempotencyClass` — those three are node-operator surface resolved live at phase
 * launch, and a definition carrying one is rejected at parse rather than ignored at
 * launch, so an imported definition cannot smuggle a weakened posture onto a machine.
 * The console renders the pair and derives nothing from it.
 */
export interface WorkflowToolBinding {
  readonly binding: McpServerBindingRef;
  readonly toolName: string;
}

/** The four V1 phase types, in the owning contract's own order. */
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
 * The three-value parallel-join policy, in lockstep with the store's own CHECK.
 *
 * Required exactly when a phase is a join — a `dependsOn` list carrying more than one
 * id — and refused on a phase that is not. The wire and the store never default it,
 * so an authoring surface writes the `fail-fast` default into what it submits.
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
 * No `schedule`, `event` or `webhook` arm is declared at V1, so no surface draws one —
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
 * honour is REFUSED rather than dropped, and a reader deciding that has to check a
 * declared set. Spelling `manual` beside the check would make a second start mode an
 * edit in two places, one of which nothing reports.
 */
export const WORKFLOW_START_MODES = ["manual"] as const;

/**
 * One definition, as `workflow.definitionRead` answers — latest unless a version was
 * asked for.
 *
 * `scopeRef` and `workflowVersionId` are additive-optional on this already-published
 * shape: a daemon at this contract revision always sets both, and their absence means
 * an older one rather than a definition with no scope identity. The console reports
 * an absent `workflowVersionId` as a version it cannot address rather than composing
 * one — no delimiter or encoding over `(definitionId, versionNumber)` exists on the
 * wire.
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
 * Every member below is required, which is the shape's own age rather than a choice:
 * the additive-optional rule for already-published shapes does not bind it. That completeness is what makes export
 * possible at all — the canonical file form is a client-side serialization of exactly
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
 * alike. It travels on the write and on no read — see the `workflowParentContentHash`
 * prerequisite on this operation's slate row.
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
 * subset. When `packages/contracts` registers these shapes and this module is deleted,
 * this read moves with the tuples it is written against.
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
 * declared has exactly two dishonest options — carry it, which widens a registered
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
