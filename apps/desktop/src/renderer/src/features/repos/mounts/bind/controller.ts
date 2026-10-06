// Binds a workspace for a session on one mount: the convert card's act, which places a converted
// chat in its new project. A bind answers with the mode and lifecycle state and no root; the
// workspace list is where a root is read from.

import type { ExecutionMode, RepoMountId } from "@ai-sidekicks/contracts/repo/mount";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import type { WorkspaceBindResponse } from "@ai-sidekicks/contracts/repo/workspace";

import { ActController } from "#renderer/features/repos/acts/act-controller.js";
import type { RepoOperations } from "#renderer/features/repos/repo-operations.js";

/** The one call this controller makes. */
export type BindOperations = Pick<RepoOperations, "bindWorkspace">;

/** What a finished bind carries: the workspace the daemon bound, in whatever state. */
export interface BindSettlement {
  readonly status: "bound";
  readonly response: WorkspaceBindResponse;
}

/** What one bind controller sends through, and the session and mount it binds. */
export interface BindControllerOptions {
  readonly operations: BindOperations;
  readonly sessionId: string;
  readonly repoMountId: string;
}

/** Sends the bind for one session on one mount. */
export class BindWorkspaceController extends ActController<BindSettlement> {
  readonly #operations: BindOperations;
  readonly #sessionId: string;
  readonly #repoMountId: string;

  public constructor(options: BindControllerOptions) {
    super({ label: "workspace bind reading" });
    this.#operations = options.operations;
    this.#sessionId = options.sessionId;
    this.#repoMountId = options.repoMountId;
  }

  /**
   * Send one bind in the mode the caller decided and publish the reply. Does not overlap itself:
   * a second press would bind a second workspace for one intent.
   */
  public async bind(executionMode: ExecutionMode, directory: string | undefined): Promise<void> {
    await this.act(
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
}
