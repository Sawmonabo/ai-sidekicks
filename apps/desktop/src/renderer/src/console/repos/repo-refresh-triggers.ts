// The one frame the repos section re-reads on, named where a workspace is understood.
//
// The mechanism — window focus, the store's repair edge, and a named frame, each
// routed to a `RefreshScheduler` — is `store/refresh-triggers.ts`'s and is shared with
// every other surface that performs its own reads. What is THIS family's is which
// frame counts as "the terminal events the owning spec names" for a workspace, and
// that is the whole of this module: the repos section re-reads on `workspace.stale`,
// and the artifact pane re-reads on artifact kinds it names for itself.
//
// A CLASS RATHER THAN A CALL SITE ARGUMENT, so the two readers in this family cannot
// answer that question differently. `repo-mounts-reader.ts` and
// `proposal-gate-reader.ts` both construct one, and until the kind lived in one place
// a second reader could have watched a different frame while reading the same rows.

import type { SessionEventType } from "@ai-sidekicks/contracts";

import { SessionRefreshTriggers, type SessionStore } from "../store/index.js";
import type { RefreshScheduler } from "../store/index.js";

/**
 * The one frame this section re-reads on.
 *
 * `satisfies SessionEventType` rather than a bare string: the type is the contract's
 * own census (`packages/contracts/src/event.ts`), so a kind renamed on the wire fails
 * to compile here instead of silently matching nothing for the life of the release.
 */
const WORKSPACE_STALE_EVENT_KIND = "workspace.stale" satisfies SessionEventType;

export interface RepoRefreshTriggerOptions {
  /** The family's one scheduler. Requested, never armed: this class owns no timer. */
  readonly scheduler: RefreshScheduler;
  /** The session whose frames and whose repair edge are two of the three reasons. */
  readonly sessionStore: SessionStore;
}

/** The shared triggers, pinned to the frame a workspace going stale sends. */
export class RepoRefreshTriggers {
  readonly #triggers: SessionRefreshTriggers;

  public constructor(options: RepoRefreshTriggerOptions) {
    this.#triggers = new SessionRefreshTriggers({
      ...options,
      terminalEventKinds: [WORKSPACE_STALE_EVENT_KIND],
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
