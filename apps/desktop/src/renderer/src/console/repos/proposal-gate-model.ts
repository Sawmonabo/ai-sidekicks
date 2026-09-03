// The gate reader's pure half: which worktree a gate is about, what a settled arm
// says out loud, and how a wire branch context becomes one the summary can draw.
//
// Split from `proposal-gate-reader.ts` on the seam this family already uses twice —
// `prepared-proposal.ts` beside `ProposalGate.tsx`, `worktree-model.ts` beside
// `WorktreeCard.tsx`: what a value IS, against the object that fetches and holds it.
// Everything here is a pure function or a closed table, so a test can hold the
// announcement vocabulary and the wire mapping without constructing a reader, a
// bridge, or a clock.
//
// NOTHING HERE CALLS, SCHEDULES, OR HOLDS STATE. The reader owns all three.

import type { ExecutionMode } from "@ai-sidekicks/contracts";

import type { ConsoleBridge } from "../bridge/index.js";
import type { BranchContextReading } from "./branch-context-model.js";

/**
 * The branch context exactly as the growth port serves it.
 *
 * DERIVED FROM THE PORT rather than imported as a named value type, because the
 * console family barrel publishes the bridge and not the reply vocabulary behind it,
 * and a hand-written mirror of the wire shape here would be a second declaration of a
 * closed set — the failure mode `apps/desktop/AGENTS.md` names outright. Deriving it
 * means a member added to, renamed on, or removed from the registered signature is a
 * compile error in the mapper below rather than a silently dropped field.
 */
type ServedBranchContext = NonNullable<
  Extract<
    Awaited<ReturnType<ConsoleBridge["growth"]["gitflowBranchContextRead"]>>,
    { readonly status: "served" }
  >["value"]["branchContext"]
>;

/** The subsystem every refusal the gate reader mints names as its author. */
export const PROPOSAL_GATE_REFUSAL_ORIGIN = "proposal-gate";

/**
 * Why an act failed on the console's side of the wire.
 *
 * Closed, and no member overlaps a growth-port or a daemon code — those travel
 * verbatim. These name the failures that are the reader's own to describe: an act
 * pressed with no served context behind it, an act the daemon answered without
 * accepting, an act pressed while another one is still unanswered, and a root the
 * registered request has no arm this console can fill for.
 */
export const PROPOSAL_GATE_REFUSAL_CODES = [
  "no-served-context",
  "action-not-accepted",
  "action-in-flight",
  "subject-not-addressable",
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
 * that already holds it rather than read again: the `no-context` arm has to name the
 * mode that explains the absence, and a second read of it here could disagree with the
 * row the gate is drawn under.
 */
export type ProposalGateSubject =
  | {
      readonly kind: "worktree";
      readonly workspaceId: string;
      readonly worktreeId: string;
      readonly executionMode: ExecutionMode;
    }
  | {
      readonly kind: "branch-root";
      readonly workspaceId: string;
      readonly executionMode: ExecutionMode;
    }
  | {
      readonly kind: "ephemeral-clone";
      readonly workspaceId: string;
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
 * only arm that could serve it is the first. `bridge/growth-signatures.ts` carries only
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
  readonly executionMode: ExecutionMode;
}): ProposalGateSubject {
  return {
    kind: "branch-root",
    workspaceId: workspace.id,
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
  workspaces: readonly { readonly id: string; readonly executionMode: ExecutionMode }[],
): ProposalGateSubject | undefined {
  const workspace = workspaces.find((row) => row.id === clone.workspaceId);
  if (workspace === undefined) {
    return undefined;
  }
  return {
    kind: "ephemeral-clone",
    workspaceId: clone.workspaceId,
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
 * A closed table rather than sentences composed at the four publish sites, so one arm
 * is never announced two ways. `not-checked` has NO entry, deliberately: its sentence
 * is the growth port's own refusal, which names the wire and the document that owes
 * it, and a console sentence beside it would paraphrase a refusal the console did not
 * author — which rule 9 forbids.
 */
export const GATE_SETTLEMENT_COPY: Readonly<Record<AnnouncedGateSettlement, string>> = {
  "no-context": "This workspace has no writable branch context.",
  prepared: "A branch context was read. No proposal has been prepared yet.",
  "prepared-with-proposal": "A branch context and a prepared proposal were read.",
  refused: "The branch context could not be read.",
};

/** The settlements that have a sentence of their own. Declared once, derived above. */
export const ANNOUNCED_GATE_SETTLEMENTS = [
  "no-context",
  "prepared",
  "prepared-with-proposal",
  "refused",
] as const;

/** One announced settlement. Derived, so the vocabulary is declared exactly once. */
export type AnnouncedGateSettlement = (typeof ANNOUNCED_GATE_SETTLEMENTS)[number];

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
