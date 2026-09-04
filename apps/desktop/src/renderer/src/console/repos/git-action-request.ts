// What a git action actually SENDS: the registered request, built from what this gate
// read and from nothing it guessed.
//
// A MODULE RATHER THAN A LITERAL AT THE CALL SITE, on the seam this family already uses
// for the read: `proposal-gate-model.ts` owns how a subject reaches the branch-context
// read, and this owns how an act reaches the git action. Both answers are decisions
// about a registered shape, and both belong beside the model rather than inside the
// class that happens to await the promise.
//
// THE REGISTERED REQUEST NAMES A MOUNT, WHICH IS COARSER THAN WHAT IS BEING ACTED ON.
// `docs/architecture/contracts/api-payload-contracts.md` types `GitActionExecuteRequest`
// as `{ repoMountId, action, params, causationRunId?, causationParticipantId? }`, and
// one mount can carry several workspaces and each of those several execution roots. So
// `repoMountId` alone cannot say WHICH checkout an act runs in — and `params` is where
// that is said, which is the whole reason the member is required and typed
// `Record<string, unknown>`: the action vocabulary is unregistered
// (`bridge/growth-slate.ts`, the `gitflow-actions` row), so the daemon cannot type the
// parameters of an action nobody has named, and stating them is the caller's job.
//
// EVERY PARAMETER COMES OFF THE SERVED CONTEXT AND NOTHING IS COMPOSED. The branch
// context is the one thing this gate has read about the root, and `branch-context-model.ts`
// forbids inferring base or head from a pane, a tab, or a focused view — so the members
// below are that reading's own, wire-verbatim. An absent optional is OMITTED rather
// than filled: there is no `origin/<head>` for a context with no upstream, because that
// is a push target no read established.
//
// WHAT IS DELIBERATELY NOT SENT, and each absence is a fact rather than an oversight:
//   • No commit message. This gate has no text input and no registered reply carries
//     one — `PROPOSAL_ACTION_PRESENTATION.commit` says the act records the working
//     tree's changes and names no message, and the prepared proposal's `title` is the
//     PROPOSAL's title, written for a host, and reusing it would be a message the
//     participant never wrote. A commit-message composer is a surface this console does
//     not have; until it does, the message is the daemon's own.
//   • No `causationRunId`. The change-proposal gate is mounted per execution root and
//     no run is in view on it, so the member is omitted rather than carrying a run this
//     surface would have had to pick.

import type { ConsoleBridge } from "../bridge/index.js";
import type { BranchContextReading } from "./branch-context-model.js";
import type { GitActionProposalAction } from "./proposal-actions.js";

/** The git action's request, derived from the port rather than transcribed. */
export type GitActionExecuteRequest = Parameters<ConsoleBridge["growth"]["gitActionExecute"]>[0];

/**
 * The context members an act's `params` may carry.
 *
 * KEYS OF THE READING ITSELF, so a member that leaves that shape stops compiling here
 * rather than becoming a parameter naming a field the console no longer holds.
 */
type GitActionParamSource = "branchContextId" | "headBranch" | "upstreamRef";

/**
 * Total over `GitActionProposalAction` by construction — which members each act sends.
 *
 * A TABLE RATHER THAN A `switch`, because the answer per act is a LIST and not a
 * branch: both acts name the root they run in, and only the remote one names where it
 * is sending. A third act routed to this wire has to say what it carries before it can
 * be sent, which is the same property every other table in `proposal-actions.ts` has.
 *
 * `branchContextId` is on both because the mount is not the root: it is the identity
 * the daemon minted for exactly this (base, head, root) triple, so it is the narrowest
 * thing this console can hand back. `headBranch` rides beside it because both acts name
 * it in their own consequence sentence — a participant reading "records on the head
 * branch" and "sends the head branch" is reading what the request says.
 */
const GIT_ACTION_PARAM_SOURCES: Readonly<
  Record<GitActionProposalAction, readonly GitActionParamSource[]>
> = {
  commit: ["branchContextId", "headBranch"],
  push: ["branchContextId", "headBranch", "upstreamRef"],
};

/**
 * The parameters one act carries, read off the context it is being sent against.
 *
 * An absent optional contributes NO KEY, which is rule 8 applied to a request rather
 * than to a screen: a context with no upstream ref has no push target set, and sending
 * `upstreamRef: undefined` would be this console asserting that it looked and found
 * nothing where in fact nothing was ever set.
 */
export function gitActionParams(
  action: GitActionProposalAction,
  context: BranchContextReading,
): Readonly<Record<string, unknown>> {
  const params: Record<string, unknown> = {};
  for (const source of GIT_ACTION_PARAM_SOURCES[action]) {
    const value = context[source];
    if (value !== undefined) {
      params[source] = value;
    }
  }
  return params;
}

/** Everything a caller must know to name an act, beyond the act and the context. */
export interface GitActionCausation {
  /** The mount the registered request names. The subject's, never re-derived here. */
  readonly repoMountId: string;
  /**
   * Which participant pressed the control, where the caller identity read answered.
   *
   * ATTRIBUTION AND NOT AUTHORITY, which is why an unread identity is not an error:
   * the member is optional on the registered request and the daemon resolves the
   * principal an act actually runs under from the transport. So a refused identity
   * read omits the member and the act still goes, rather than the console blocking a
   * press over a fact the daemon does not take from it — and it is never filled with a
   * placeholder, which would be a claim about who acted.
   */
  readonly causationParticipantId?: string | undefined;
}

/**
 * The registered request for one act, whole.
 *
 * ONE FUNCTION RATHER THAN A LITERAL PER CALL SITE: the request has five members, two
 * of them optional, and `exactOptionalPropertyTypes` makes an explicit `undefined` a
 * different type from an absent member — so a caller spreading the causation by hand
 * would send `causationParticipantId: undefined` on exactly the path where the identity
 * could not be read. The spread below is conditional for that reason.
 */
export function gitActionExecuteRequest(
  action: GitActionProposalAction,
  context: BranchContextReading,
  causation: GitActionCausation,
): GitActionExecuteRequest {
  return {
    repoMountId: causation.repoMountId,
    action,
    params: gitActionParams(action, context),
    ...(causation.causationParticipantId === undefined
      ? {}
      : { causationParticipantId: causation.causationParticipantId }),
  };
}
