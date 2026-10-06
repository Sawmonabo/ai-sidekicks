// Prepares one workspace's execution root. A prepare is never re-sent on a refresh: that would
// put a second root on disk for one press.

import type { WorkspaceId } from "@ai-sidekicks/contracts/repo/mount";
import type { ExecutionRootPrepareResponse } from "@ai-sidekicks/contracts/worktree/lifecycle";

import { ActController } from "#renderer/features/repos/acts/act-controller.js";
import { type ActSettlementReading } from "#renderer/features/repos/acts/act-reading.js";
import type { RepoOperations } from "#renderer/features/repos/repo-operations.js";

/** The one call this controller makes. */
export type PrepareOperations = Pick<RepoOperations, "prepareExecutionRoot">;

/** What a finished prepare carries: the root on disk, and the state it is in. */
export type PrepareSettlement = { readonly status: "prepared" } & Readonly<
  Pick<ExecutionRootPrepareResponse, "executionRoot" | "state">
>;

/** Where the prepare stands. What a form renders. */
export type PrepareReading = ActSettlementReading<PrepareSettlement>;

/** What one prepare controller sends through, and the workspace it prepares. */
export interface PrepareControllerOptions {
  readonly operations: PrepareOperations;
  readonly workspaceId: string;
}

/** Sends prepares for one workspace. */
export class ExecutionRootPrepareController extends ActController<PrepareSettlement> {
  readonly #operations: PrepareOperations;
  readonly #workspaceId: string;

  public constructor(options: PrepareControllerOptions) {
    super({ label: "execution root prepare reading" });
    this.#operations = options.operations;
    this.#workspaceId = options.workspaceId;
  }

  /** Prepare a root that checks out this branch. Does not overlap itself. */
  public async prepare(branchName: string): Promise<void> {
    await this.act(
      async () =>
        await this.#operations.prepareExecutionRoot({
          workspaceId: this.#workspaceId as WorkspaceId,
          branchName,
        }),
      (value: ExecutionRootPrepareResponse) => ({
        status: "prepared" as const,
        executionRoot: value.executionRoot,
        state: value.state,
      }),
    );
  }
}
