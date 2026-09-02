// What a prepared proposal IS on the way to a git host, read as something the gate can
// draw — and nothing else. No React, no calls, no eligibility.
//
// THIS SURFACE'S JOB, stated here because `Spec-023 §Console Design (Meridian)` puts a
// surface's composition in the console's code: show exactly
// what will be sent to the git host, and let a participant approve it before anything
// leaves the machine. Four of those words are decisions the gate must not make twice,
// and they live in four modules beside each other rather than in one: this file owns
// what a prepared proposal carries and how its untyped blob becomes display data;
// `hosting-status.ts` owns what the host's three trichotomies MEAN and how a check list
// rolls up; `proposal-actions.ts` owns which acts exist and when each is offered; and
// `proposal-gate-state.ts` owns the arms the gate can be in. What the branch context is
// bound to is `branch-context-model.ts`'s, because a context outlives any one proposal.
//
// EVERY SHAPE BELOW IS THE CONSOLE'S OWN, AND SAYS SO. `packages/contracts` registers
// no `gitflow` module: there is no `ChangeRequest` and no proposal type anywhere in the
// workspace. So these are the shapes the SURFACE needs, derived from what this family
// draws, exactly as `bridge/growth-port.ts` derives its request and value types: they
// are not a claim about the eventual wire, which `Spec-011` owns.
//
// NO STACKED PROPOSALS. One cumulative proposal per run lineage is what
// `ONE_CUMULATIVE_PROPOSAL_COPY` says out loud, and it is the whole of this module's
// position on how many proposals a worktree can have.

/** Whether the host would publish this proposal or hold it. The wire's own two words. */
export const PROPOSAL_STATES = ["draft", "ready"] as const;

/** One proposal state. Derived, so the vocabulary is declared exactly once. */
export type ProposalState = (typeof PROPOSAL_STATES)[number];

/**
 * What a prepared proposal puts on screen, before any remote mutation.
 *
 * `blob` is deliberately untyped and deliberately last. THIS MODULE'S RULE, because no
 * committed document states it: the proposal is rendered from an untyped `proposalBlob`,
 * so the renderer treats
 * unknown keys as inert display data and never as instructions — `proposalBlobRows`
 * below is the only reader of it, and it produces strings.
 */
export interface PreparedProposal {
  /**
   * FOUR MEMBERS BELOW ARE OPTIONAL BECAUSE NO REGISTERED REPLY CARRIES THEM.
   *
   * The preparation call answers with a preparation id, a state, and an untyped
   * blob (`bridge/growth-signatures.ts`, `gitflowPrPrepare`), so a reader can supply
   * the two branches — from the branch context, which `branch-context-model.ts` makes
   * the only source of base and head — and the state, and nothing else. Absence is therefore
   * the honest reading, and each one renders as the "nobody supplied this" kind of
   * nothing rather than as a default: an empty title reads as an untitled proposal
   * and an empty path list reads as a proposal that changes no files, and both are
   * claims about the proposal that no read established.
   *
   * They stay on the shape rather than being deleted because they are what this family
   * asks the gate to show, and a caller that HAS them — the fixtures the tiers pin,
   * and any later reply that carries them — draws the full surface unchanged.
   */
  readonly title?: string | undefined;
  readonly body?: string | undefined;
  readonly baseBranch: string;
  readonly headBranch: string;
  readonly state: ProposalState;
  /** The attribution lines the proposal will carry, verbatim and in order. */
  readonly trailers?: readonly string[] | undefined;
  /** The paths this proposal publishes. Named so the gate can offer the diff half. */
  readonly changedPaths?: readonly string[] | undefined;
  readonly blob?: Readonly<Record<string, unknown>> | undefined;
}

/**
 * The proposal members this gate draws that no registered reply supplies.
 *
 * A closed set with one sentence each, declared here and derived everywhere, so the
 * summary cannot word one absence differently from another, and a member that later
 * ARRIVES on the wire is removed from one list rather than hunted for in prose.
 */
export const PROPOSAL_MEMBERS_NOT_ON_THE_WIRE = [
  "title",
  "body",
  "trailers",
  "changedPaths",
] as const;

/** One unsupplied proposal member. Derived, so the vocabulary is declared once. */
export type ProposalMemberNotOnTheWire = (typeof PROPOSAL_MEMBERS_NOT_ON_THE_WIRE)[number];

/** Total over `ProposalMemberNotOnTheWire` by construction. */
export const PROPOSAL_MEMBER_UNSUPPLIED_COPY: Readonly<Record<ProposalMemberNotOnTheWire, string>> =
  {
    title: "No title came with this preparation.",
    body: "No body came with this preparation.",
    trailers: "No trailer list came with this preparation.",
    changedPaths: "No file list came with this preparation.",
  };

/**
 * The three members that decide whether a prepared proposal still belongs to a context.
 *
 * Kept BESIDE `PreparedProposal` rather than on it: that shape is what
 * `ProposalSummary` draws, no registered reply carries a context key, and a member on
 * the display type would be one the wire does not have. Whether a held proposal is
 * still current is the holder's question, and this is the vocabulary it asks in.
 *
 * THE ID ALONE IS NOT ENOUGH. A workspace repair can re-establish the same context row
 * over a moved head, and a proposal built against the old head would then be offered
 * for sending under the new one — which is the case the branches are here for.
 */
export interface ProposalContextKey {
  readonly branchContextId: string;
  readonly baseBranch: string;
  readonly headBranch: string;
}

/**
 * The key a context supplies, narrowed to the three members that decide the pairing.
 *
 * Typed on `ProposalContextKey` rather than on the branch-context reading, so this
 * module states what it needs and takes no dependency on the model that happens to
 * carry it.
 */
export function proposalContextKeyOf(context: ProposalContextKey): ProposalContextKey {
  return {
    branchContextId: context.branchContextId,
    baseBranch: context.baseBranch,
    headBranch: context.headBranch,
  };
}

/** Whether a proposal prepared under `key` is still current under `context`. */
export function proposalContextKeysMatch(
  key: ProposalContextKey,
  context: ProposalContextKey,
): boolean {
  return (
    key.branchContextId === context.branchContextId &&
    key.baseBranch === context.baseBranch &&
    key.headBranch === context.headBranch
  );
}

/** One inert row read out of the untyped proposal blob. Both halves are display text. */
export interface ProposalBlobRow {
  readonly key: string;
  readonly text: string;
}

/**
 * Turn the untyped blob into rows.
 *
 * THREE PROPERTIES, AND EACH IS THE RULE RATHER THAN A CONVENIENCE:
 *   1. Every value becomes a STRING here. A caller therefore cannot branch on a
 *      blob's shape, which is what "never as instructions" means structurally — a
 *      key named `action`, `onClick`, or `__html` reaches the screen as the text of
 *      its value and as nothing else.
 *   2. Keys are sorted, so two reads of one proposal draw the same rows. Object key
 *      order is the producer's, and a gate whose rows reshuffle between reads reads
 *      as a proposal that changed.
 *   3. A value that will not stringify becomes the stated fallback rather than
 *      throwing inside a list row. `JSON.stringify` returns `undefined` for a
 *      function or a `symbol` and throws on a cycle; both land on the same sentence.
 */
export function proposalBlobRows(
  blob: Readonly<Record<string, unknown>> | undefined,
): readonly ProposalBlobRow[] {
  if (blob === undefined) {
    return [];
  }
  return Object.keys(blob)
    .sort((left, right) => left.localeCompare(right))
    .map((key) => ({ key, text: proposalBlobValueText(blob[key]) }));
}

/** What a blob value that cannot be rendered as text says instead. */
export const PROPOSAL_BLOB_UNRENDERABLE = "(a value the console cannot render as text)";

function proposalBlobValueText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    const serialized = JSON.stringify(value);
    return serialized ?? PROPOSAL_BLOB_UNRENDERABLE;
  } catch {
    return PROPOSAL_BLOB_UNRENDERABLE;
  }
}

/**
 * The one sentence this module asks to be said plainly, kept out of the component so
 * the claim and the surface that makes it can be held against each other by a test.
 */
export const ONE_CUMULATIVE_PROPOSAL_COPY =
  "One proposal covers this run lineage. Further commits in this worktree update it rather than opening another.";
