// The frames the repos section re-reads on, named where a repository is understood.
//
// The mechanism — window focus, the store's repair edge, and a named frame, each
// routed to a `RefreshScheduler` — is `store/refresh-triggers.ts`'s and is shared with
// every other surface that performs its own reads. What is THIS family's is which
// frames count as "the terminal events the owning spec names" for a repository, and
// that is the whole of this module: the repos section re-reads on every registered
// lifecycle frame that names a repo, a workspace, or a worktree, and the artifact pane
// re-reads on artifact kinds it names for itself.
//
// A CLASS RATHER THAN A CALL SITE ARGUMENT, so the two readers in this family cannot
// answer that question differently. `repo-mounts-reader.ts` and
// `proposal-gate-reader.ts` both construct one, and until the kinds lived in one place
// a second reader could have watched a different frame while reading the same rows.
//
// ONE FRAME WAS NOT ENOUGH, AND THE MISSING ONES WERE THE TERMINAL HALF. This trigger
// watched `workspace.stale` alone — the frame that says a workspace BROKE — so every
// frame that says one was repaired, attached, detached, or provisioned reached nobody.
// The mode picker made that visible: an explicit switch answers `provisioning` with no
// execution root (the root does not exist yet), the daemon later emits `workspace.ready`
// carrying it, and the section went on drawing the provisioning row until a focus, a
// reconnect, or another mutation happened to arrive. The same hole covered
// `repo.attached` / `repo.detached`, which change the mount list this section is drawn
// from, and the five `worktree.*` transitions, which change the execution roots and the
// gates bound to them.

import { SESSION_EVENT_CATEGORY_BY_TYPE, type SessionEventType } from "@ai-sidekicks/contracts";

import { SessionRefreshTriggers, type SessionStore } from "../store/index.js";
import type { RefreshScheduler } from "../store/index.js";

/**
 * The wire namespaces whose frames can change what this family has read.
 *
 * The three entities the two readers hold: a mount (`repo.mountRead`), a workspace
 * (`repo.workspaceList` and the per-workspace capabilities read), and an execution root
 * (`repo.worktreeStatusRead`, which answers with worktrees and clones together). A
 * frame in any of the three changes a row, a state, a health verdict, or the subject a
 * proposal gate is bound to.
 *
 * Ephemeral clones are covered by `worktree.` rather than by a namespace of their own,
 * and that is a fact about the census rather than an omission: no `clone.*` type is
 * registered — clone transitions are not separately evented — so a clone reaches this
 * section only through the root read, which the worktree frames already re-run.
 */
const REPO_EVENT_NAMESPACE_PREFIXES = ["repo.", "workspace.", "worktree."] as const;

/**
 * Every registered lifecycle frame that names one of this family's three entities.
 *
 * DERIVED FROM THE CONTRACT'S OWN CENSUS rather than hand-listed, so a kind the wire
 * adds in one of these namespaces is watched the day it is registered and a kind it
 * renames stops matching nothing silently. `SESSION_EVENT_CATEGORY_BY_TYPE` is the
 * canonical type registry — its keys are the whole census — and the filter selects by
 * NAMESPACE, which is the question this family is asking ("does this frame name a repo,
 * a workspace, or a worktree"). It deliberately does not infer a category from a
 * prefix, which `packages/contracts/src/event.ts` warns against: a type's category is
 * the registry's to state, and this set never reads one.
 *
 * The annotation is explicit rather than inferred, because `isolatedDeclarations`
 * requires one on every exported binding.
 */
export const REPO_LIFECYCLE_EVENT_KINDS: readonly SessionEventType[] = [
  ...SESSION_EVENT_CATEGORY_BY_TYPE.keys(),
].filter((eventType) =>
  REPO_EVENT_NAMESPACE_PREFIXES.some((prefix) => eventType.startsWith(prefix)),
);

export interface RepoRefreshTriggerOptions {
  /** The family's one scheduler. Requested, never armed: this class owns no timer. */
  readonly scheduler: RefreshScheduler;
  /** The session whose frames and whose repair edge are two of the three reasons. */
  readonly sessionStore: SessionStore;
}

/**
 * The shared triggers, pinned to the frames a repository's lifecycle sends.
 *
 * ONE READ PER BURST, WHICH IS WHY A WIDER SET COSTS NOTHING. `SessionRefreshTriggers`
 * asks the scheduler for a read when a transition carries ANY watched kind — once per
 * transition, not once per frame — and the scheduler coalesces the request into the
 * window it is already holding. So a workspace that reprovisions through
 * `provisioning` and `ready`, and the five worktree transitions behind it, are one
 * re-read rather than seven.
 */
export class RepoRefreshTriggers {
  readonly #triggers: SessionRefreshTriggers;

  public constructor(options: RepoRefreshTriggerOptions) {
    this.#triggers = new SessionRefreshTriggers({
      ...options,
      terminalEventKinds: REPO_LIFECYCLE_EVENT_KINDS,
    });
  }

  public start(): void {
    this.#triggers.start();
  }

  /** Terminal. No later frame and no later focus can re-arm a read behind an unmount. */
  public dispose(): void {
    this.#triggers.dispose();
  }
}
