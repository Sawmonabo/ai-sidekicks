// Binds a workspace on one mount: reads what the mount admits, then sends the bind.
// The read is made when the dialog opens, not when the card mounts, so a session with many
// mounts does not put a read on the wire per mount. A bind answers with the mode and lifecycle
// state and no root; the workspace list is where a root is read from.

import type { ExecutionMode, RepoMountId } from "@ai-sidekicks/contracts/repo";
import type { SessionId } from "@ai-sidekicks/contracts/session";
import type {
  WorkspaceBindResponse,
  WorkspaceExecutionModeCapabilitiesReadResponse,
} from "@ai-sidekicks/contracts/workspace";
import type { Clock } from "@renderer/lib/clock.js";
import { ActControllerBase } from "../../acts/act-controller-base.js";
import { type ActReading } from "../../acts/act-reading.js";
import { type SessionStore } from "@renderer/store/session/session-store.js";
import { REPO_LIFECYCLE_EVENT_KINDS } from "../../repo-lifecycle-events.js";
import type { RepoOperations } from "../../repo-operations.js";

/** What a finished bind carries: the workspace the daemon bound, in whatever state. */
export interface BindSettlement {
  readonly status: "bound";
  readonly response: WorkspaceBindResponse;
}

/** Both halves, published together so a dialog renders one consistent frame. */
export type BindReading = ActReading<
  WorkspaceExecutionModeCapabilitiesReadResponse,
  BindSettlement
>;

/** What one bind controller is scoped to: a mount, its session, and the clock. */
export interface BindControllerOptions {
  readonly operations: BindOperations;
  readonly repoMountId: string;
  /** The session a bound workspace belongs to, whose frames re-ask the pre-bind question. */
  readonly sessionStore: SessionStore;
  /** The window the reading is drawn in; its regaining focus re-asks. */
  readonly ownerWindow: Window;
  /** The window's one clock, so this refresh coalesces on the section's time base. */
  readonly clock: Clock;
}

type BindOperations = Pick<RepoOperations, "bindWorkspace" | "readMountExecutionModes">;

/** The one pre-bind question; a constant so a reopened dialog stays off the wire. */
const CAPABILITIES_QUESTION = "capabilities";

/** Reads what a mount admits and sends the bind for it. */
export class BindWorkspaceController extends ActControllerBase<
  WorkspaceExecutionModeCapabilitiesReadResponse,
  BindSettlement
> {
  readonly #operations: BindOperations;
  readonly #repoMountId: string;
  readonly #sessionId: string;

  public constructor(options: BindControllerOptions) {
    super({
      label: "workspace bind reading",
      clock: options.clock,
      sessionStore: options.sessionStore,
      ownerWindow: options.ownerWindow,
      // The frames that change what a mount admits.
      triggeringEventKinds: new Set<string>(REPO_LIFECYCLE_EVENT_KINDS),
    });
    this.#operations = options.operations;
    this.#repoMountId = options.repoMountId;
    this.#sessionId = options.sessionStore.sessionId;
  }

  /** Ask what this mount admits. Idempotent: reopening the dialog does not read again. */
  public requestCapabilities(): void {
    this.askPrerequisite(CAPABILITIES_QUESTION, "subscribe");
  }

  /**
   * Send one bind and publish the reply. Does not overlap itself: a second press would bind
   * a second workspace for one intent.
   */
  public async bind(executionMode: ExecutionMode, directory: string | undefined): Promise<void> {
    await this.sendAct(
      async () =>
        await this.#operations.bindWorkspace({
          sessionId: this.#sessionId as SessionId,
          repoMountId: this.#repoMountId as RepoMountId,
          executionMode,
          // Omitted, not emptied: an absent member means the mount root, and an empty string
          // is refused by the parser.
          ...(directory === undefined ? {} : { directory }),
        }),
      (response: WorkspaceBindResponse) => ({ status: "bound" as const, response }),
    );
  }

  /** Reads what the mount admits, passing the round's signal so a closed dialog drops the reply. */
  protected override async readPrerequisite(
    _question: string,
    signal: AbortSignal,
  ): Promise<WorkspaceExecutionModeCapabilitiesReadResponse> {
    return await this.#operations.readMountExecutionModes(this.#repoMountId as RepoMountId, signal);
  }
}
