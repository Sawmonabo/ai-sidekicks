// The gate reader's pure half: which worktree a gate is about, what a settled arm
// says out loud, how a wire branch context becomes one the summary can draw, and the
// one value everything a gate renders arrives in.
//
// Split from `proposal-gate-reader.ts` on the seam this family already uses twice —
// `prepared-proposal.ts` beside `ProposalGate.tsx`, `worktree-model.ts` beside
// `WorktreeCard.tsx`: what a value IS, against the object that fetches and holds it.
// Everything here is a pure function or a closed table, so a test can hold the
// announcement vocabulary and the wire mapping without constructing a reader, a
// bridge, or a clock.
//
// NOTHING HERE CALLS, SCHEDULES, OR HOLDS STATE. The reader owns all three.
//
// THE READING LIVES HERE RATHER THAN ON EITHER CLASS, and that is structural rather
// than tidy: `proposal-gate-reader.ts` publishes one and `proposal-gate-actions.ts`
// publishes one, so declaring it on either would make the other import its sibling
// and close a cycle the layering gate refuses. The value is a value; the two objects
// that write it are next door.

import type { ExecutionMode } from "@ai-sidekicks/contracts";

import type { ConsoleBridge } from "../../bridge/index.js";
import type { ConsoleRefusal } from "../../core/index.js";
import type { BranchContextReading } from "../mounts/branch-context-model.js";
import type { ProposalAction } from "./proposal-actions.js";
import type { ProposalGateState } from "./proposal-gate-state.js";

/**
 * The branch context exactly as the growth port serves it.
 *
 * DERIVED FROM THE PORT rather than imported as a named value type, because the
 * console family barrel publishes the bridge and not the reply vocabulary behind it,
 * and a hand-written mirror of the wire shape here would be a second declaration of a
 * closed set — the failure mode `apps/desktop/AGENTS.md` names outright. Deriving it
 * means a member added to, renamed on, or removed from the registered signature is a
 * compile error in the mapper below rather than a silently dropped field.
 *
 * THE SERVED VALUE IS THE CONTEXT ITSELF. `BranchContextReadResponse` is flat, so
 * there is no envelope member to reach through and no `NonNullable` to strip: a
 * served reply IS a context, and a pair that resolves none refuses instead.
 */
type ServedBranchContext = Extract<
  Awaited<ReturnType<ConsoleBridge["growth"]["gitflowBranchContextRead"]>>,
  { readonly status: "served" }
>["value"];

/**
 * The reading a gate carries before anything has been asked.
 *
 * Beside the type it fills rather than in the reader that publishes it first: rule 8
 * separates "nobody asked" from every answer, and the value that states it is part of
 * the shape's own vocabulary — a second reader spelling its own would be a second
 * opinion about what an unasked gate says.
 */
export const NOTHING_ASKED_GATE_READING: ProposalGateReading = {
  state: { kind: "not-checked" },
  refusal: undefined,
  actionRefusals: new Map(),
  inFlightAction: undefined,
  settlement: undefined,
};

/** The subsystem every refusal the gate reader mints names as its author. */
export const PROPOSAL_GATE_REFUSAL_ORIGIN = "proposal-gate";

/**
 * Why an act failed on the console's side of the wire.
 *
 * Closed, and no member overlaps a growth-port or a daemon code — those travel
 * verbatim. These name the failures that are the reader's own to describe: an act
 * pressed with no served context behind it, an act the daemon answered without
 * accepting, an act pressed while another one is still unanswered, a root the
 * registered request has no arm this console can fill for, and an act whose context
 * the gate read again while that act was still waiting to go on the wire.
 */
export const PROPOSAL_GATE_REFUSAL_CODES = [
  "no-served-context",
  "action-not-accepted",
  "action-in-flight",
  "subject-not-addressable",
  "context-superseded",
] as const;

/** One reader-side refusal code. Derived, so the vocabulary is declared exactly once. */
export type ProposalGateRefusalCode = (typeof PROPOSAL_GATE_REFUSAL_CODES)[number];

/**
 * The one code the collapsed line reads, named once because two modules name it.
 *
 * The reader mints it and the disclosure's summary line branches on it — so a literal
 * in each would be two spellings of one value, and a rename would silently turn the
 * line back into the one this code exists to replace.
 */
export const SUBJECT_NOT_ADDRESSABLE: ProposalGateRefusalCode = "subject-not-addressable";

/**
 * Which execution root a gate is about.
 *
 * A DISCRIMINATED UNION rather than one shape with optional ids, because the ids are
 * not optional per kind — a worktree root always has a worktree id, a clone root always
 * has a clone id, and a branch root has neither because it binds no separate root
 * (`branch-context-model.ts` calls that association `in-place`). One shape carrying
 * both as optional would make "a worktree subject with no worktree id" representable,
 * which is exactly the value the read below cannot be built from.
 *
 * `executionMode` is on every arm and is the WORKSPACE's own, supplied by the surface
 * that already holds it rather than read again: the served context carries no mode of
 * its own, the summary reports the one the row is drawn under, and a second read of it
 * here could disagree with that row.
 *
 * `repoMountId` is on every arm for a different reason: it is not what the gate READS
 * under — the branch-context read is keyed by the workspace and the root — but it is
 * the only identity the registered `GitActionExecuteRequest` takes, so an act sent from
 * a subject that did not carry it could not name what it was acting on. Every arm
 * resolves it from the SAME place, the workspace row's own `repoMountId`: a branch
 * root and a clone are built from that row directly, and a worktree's is the row it was
 * paired under, which `worktree-gate-pairing.ts` resolves by that very mount. The
 * worktree record carries a `repoMountId` of its own and it is the same value by
 * construction — that pairing filters both sides on it — so this is one fact read once
 * rather than two that could disagree.
 */
export type ProposalGateSubject =
  | {
      readonly kind: "worktree";
      readonly workspaceId: string;
      readonly repoMountId: string;
      readonly worktreeId: string;
      readonly executionMode: ExecutionMode;
    }
  | {
      readonly kind: "branch-root";
      readonly workspaceId: string;
      readonly repoMountId: string;
      readonly executionMode: ExecutionMode;
    }
  | {
      readonly kind: "ephemeral-clone";
      readonly workspaceId: string;
      readonly repoMountId: string;
      readonly cloneId: string;
      readonly executionMode: ExecutionMode;
    };

/**
 * The execution roots a gate can be about. Closed at three, one per writable mode.
 *
 * `Spec-010` gives a workspace three writable execution modes and each materialises a
 * DIFFERENT kind of root: `worktree` a dedicated checkout with a record of its own,
 * `branch` the mount's own checkout with no record at all, and `ephemeral clone` a
 * clone row anchored to a workspace. A gate built only from worktree records therefore
 * reached one of the three, and participants in the other two had no way to read a
 * branch context, prepare a proposal, or ask for a reviewed act.
 *
 * TYPED FROM THE UNION'S OWN DISCRIMINANT rather than declared a second time: the
 * union above is where the set lives, and this is the walkable enumeration of it a
 * test iterates. A member here the union does not carry is a compile error. The
 * annotation is explicit rather than inferred through `as const`, because
 * `isolatedDeclarations` requires one on every exported binding.
 */
export const PROPOSAL_GATE_SUBJECT_KINDS: readonly ProposalGateSubject["kind"][] = [
  "worktree",
  "branch-root",
  "ephemeral-clone",
];

/** The branch-context read's request, derived from the port rather than transcribed. */
type BranchContextReadRequest = Parameters<ConsoleBridge["growth"]["gitflowBranchContextRead"]>[0];

/**
 * How one subject reaches the registered branch-context read, or why it cannot.
 *
 * ONE ANSWER RATHER THAN A PREDICATE PLUS A BUILDER. "Can the question be put" and
 * "what does it carry" are the same fact — the registered request has exactly one arm
 * this console can fill — and two functions answering separately could disagree about
 * a kind, which would put a gate into a read it has no key for.
 */
export type BranchContextReadPlan =
  | { readonly kind: "askable"; readonly request: BranchContextReadRequest }
  | { readonly kind: "unaddressable"; readonly reason: string };

/**
 * What a branch root's gate says instead of a reading.
 *
 * A DESIGNED ABSENCE AND NEVER A GUESS. `docs/architecture/contracts/api-payload-contracts.md`
 * gives `BranchContextRead` two arms — a `branchContextId`, or a `worktreeId` paired
 * with its `workspaceId` — and a branch-mode workspace has no worktree at all, so the
 * only arm that could serve it is the first. `bridge/growth-signatures/gitflow.ts` carries only
 * the second, and records why: `BranchContextId` is minted by `repo.executionRootPrepare`,
 * a wire the console does not have and no growth row carries, so there is nothing to
 * ask with. Sending the workspace id alone would be a request shape no producer
 * accepts, and inventing a key would be worse than saying so.
 */
export const BRANCH_ROOT_UNADDRESSABLE_COPY =
  "This workspace runs in its own checkout, which the branch-context read reaches by a context id. Nothing this console can call mints one, so the question is not put rather than put under a key the read does not take.";

/**
 * What an ephemeral clone's gate says instead of a reading.
 *
 * The clone's own id is a REPLY member and never a request one: the read answers with
 * `ephemeralCloneId` on a clone-anchored context and takes no clone key on either arm.
 * So a clone root is in the same position as a branch root and for a sharper reason —
 * the identifier it does have is on the wrong side of the call.
 */
export const EPHEMERAL_CLONE_UNADDRESSABLE_COPY =
  "This clone's id is something the branch-context read answers WITH, not something it can be asked by, and the context id that would key the read is minted by a wire this console does not have. So the question is not put rather than put under a guess.";

/**
 * Read one subject's plan for reaching the branch context.
 *
 * A `switch` over the kind rather than a table, because the askable arm has to REACH
 * INTO the subject for the id its arm carries — which only the narrowed member has.
 * Total by construction: a fourth kind does not compile until it says which it is.
 */
export function branchContextReadPlanFor(subject: ProposalGateSubject): BranchContextReadPlan {
  switch (subject.kind) {
    case "worktree":
      return {
        kind: "askable",
        request: { workspaceId: subject.workspaceId, worktreeId: subject.worktreeId },
      };
    case "branch-root":
      return { kind: "unaddressable", reason: BRANCH_ROOT_UNADDRESSABLE_COPY };
    case "ephemeral-clone":
      return { kind: "unaddressable", reason: EPHEMERAL_CLONE_UNADDRESSABLE_COPY };
  }
}

/**
 * The subject for a workspace executing in its own checkout.
 *
 * Built from the workspace row alone, because that is all a branch root IS: `branch`
 * mode binds no separate root, so there is no record to pair with and no pairing rule
 * to get wrong.
 */
export function branchRootGateSubject(workspace: {
  readonly id: string;
  readonly repoMountId: string;
  readonly executionMode: ExecutionMode;
}): ProposalGateSubject {
  return {
    kind: "branch-root",
    workspaceId: workspace.id,
    repoMountId: workspace.repoMountId,
    executionMode: workspace.executionMode,
  };
}

/**
 * The subject for one ephemeral-clone root.
 *
 * The clone row names its own workspace (`ephemeral_clones.workspace_id`), so unlike a
 * worktree there is no pairing to infer. What the row does NOT name is that workspace's
 * mode, so it is taken from the roster row — and where the roster names no such
 * workspace there is no subject, on `worktree-gate-pairing.ts`'s rule: a mode this
 * module chose would be a guess rendered as a reading.
 */
export function ephemeralCloneGateSubject(
  clone: { readonly cloneId: string; readonly workspaceId: string },
  workspaces: readonly {
    readonly id: string;
    readonly repoMountId: string;
    readonly executionMode: ExecutionMode;
  }[],
): ProposalGateSubject | undefined {
  const workspace = workspaces.find((row) => row.id === clone.workspaceId);
  if (workspace === undefined) {
    return undefined;
  }
  return {
    kind: "ephemeral-clone",
    workspaceId: clone.workspaceId,
    // The clone row names no mount at all — `ephemeral_clones` is workspace-anchored —
    // so the mount an act is sent under comes from the roster row the mode came from,
    // which is the same row and the same read. Two facts from one lookup, never two.
    repoMountId: workspace.repoMountId,
    cloneId: clone.cloneId,
    executionMode: workspace.executionMode,
  };
}

/** What a clone's gate says where the roster this section read names no such workspace. */
export const CLONE_WORKSPACE_UNNAMED_COPY =
  "The workspace this clone belongs to is not in the roster this section read, so there is nothing to name the execution mode a gate would report against.";

/**
 * Which settled arms are announced, and what each one says.
 *
 * A closed table rather than sentences composed at the publish sites, so one arm is
 * never announced two ways. `not-checked` has NO entry, deliberately: its sentence is
 * the growth port's own refusal, which names the wire and the document that owes it,
 * and a console sentence beside it would paraphrase a refusal the console did not
 * author — which rule 9 forbids.
 */
export const GATE_SETTLEMENT_COPY: Readonly<Record<AnnouncedGateSettlement, string>> = {
  prepared: "A branch context was read. No proposal has been prepared yet.",
  "prepared-with-proposal": "A branch context and a prepared proposal were read.",
  refused: "The branch context could not be read.",
};

/** The settlements that have a sentence of their own. Declared once, derived above. */
export const ANNOUNCED_GATE_SETTLEMENTS = [
  "prepared",
  "prepared-with-proposal",
  "refused",
] as const;

/** One announced settlement. Derived, so the vocabulary is declared exactly once. */
export type AnnouncedGateSettlement = (typeof ANNOUNCED_GATE_SETTLEMENTS)[number];

/**
 * Everything one execution root's gate renders from, in one immutable value.
 *
 * `refusal` is a FIELD rather than a seventh arm because two of the six arms carry no
 * message of their own: `not-checked` is the arm a wire-unregistered refusal produces
 * and it says nothing about which wire, so the refusal travels beside it and the
 * surface renders it through the same `RefusalCard` the repos section uses for a
 * refused mount list. An arm that DOES carry its message — `refused` — leaves this
 * field undefined, so the same sentence is never printed twice.
 */
export interface ProposalGateReading {
  readonly state: ProposalGateState;
  /** The read's own failure, where the published arm admits no message. */
  readonly refusal: ConsoleRefusal | undefined;
  /**
   * What the last press of each act produced. Rendered beside the control pressed.
   *
   * An act's entry is dropped the moment that act is issued again, so what stands here
   * is always a failure of the most recent press and never one a later success outran.
   */
  readonly actionRefusals: ReadonlyMap<ProposalAction, ConsoleRefusal>;
  /**
   * The act this gate is waiting on the bridge for, or `undefined` where none is.
   *
   * ONE AT A TIME IS A PROPERTY OF THE HOLDER, not of the surface that draws it. Two
   * preparations settling out of order let the older proposal overwrite the newer one,
   * and two commits confirmed against one payload are two commits. The surface renders
   * this member by holding its controls; the rule is enforced in
   * `proposal-gate-actions.ts`, where a second request is refused whatever pressed it.
   */
  readonly inFlightAction: ProposalAction | undefined;
  /**
   * One sentence naming what this gate settled on, or `undefined` before it has.
   *
   * Composed off the publish rather than in the component so the announcement and the
   * arm cannot disagree: the sentence is a function of the same publish that moved the
   * arm, and a surface that announced from its own render body would speak once per
   * render.
   */
  readonly settlement: string | undefined;
}

/**
 * Turn the wire's branch context into the shape the summary draws.
 *
 * `workspaceId` is dropped rather than carried: the gate is already mounted under one
 * workspace, and a second copy of that id on a display shape is a value that can
 * disagree with the row it sits in. The three optional members are spread
 * conditionally because `exactOptionalPropertyTypes` makes an explicit `undefined` a
 * different type from an absent member, and the display shape means absent.
 */
export function branchContextReadingFrom(
  branchContext: ServedBranchContext,
  executionMode: ExecutionMode,
): BranchContextReading {
  return {
    branchContextId: branchContext.branchContextId,
    baseBranch: branchContext.baseBranch,
    headBranch: branchContext.headBranch,
    executionMode,
    ...(branchContext.upstreamRef === undefined ? {} : { upstreamRef: branchContext.upstreamRef }),
    ...(branchContext.worktreeId === undefined ? {} : { worktreeId: branchContext.worktreeId }),
    ...(branchContext.ephemeralCloneId === undefined
      ? {}
      : { ephemeralCloneId: branchContext.ephemeralCloneId }),
  };
}
