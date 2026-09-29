// The attach act: the call it sends, and what it publishes.
//
// Attach asks nothing first, so it is the store's act half alone: the single-flight guard,
// the disposed latch, and the members a dialog reads them by. What is left here is what
// is attach's own, which call it makes and how the reply reads.
//
// A mount belongs to the machine, so the call carries the path and nothing about the
// session; the session only scopes which dialog's settlement is on screen.

import type { RepoAttachResponse } from "@ai-sidekicks/contracts";
import { ActController } from "../../acts/act-controller.js";
import { type ActSettlementReading } from "../../acts/act-reading.js";
import type { RepoOperations } from "../../repo-operations.js";

/** What a finished attach carries: the mount the daemon minted for it. */
export interface AttachSettlement {
  readonly status: "attached";
  readonly response: RepoAttachResponse;
}

/** Where the attach stands. What a dialog renders. */
export type AttachRequestReading = ActSettlementReading<AttachSettlement>;

/** What one attach controller sends through. */
export interface AttachControllerOptions {
  readonly operations: Pick<RepoOperations, "attachRepository">;
}

/** Sends the attach. */
export class AttachController extends ActController<AttachSettlement> {
  readonly #operations: Pick<RepoOperations, "attachRepository">;

  public constructor(options: AttachControllerOptions) {
    super({ label: "repository attach reading" });
    this.#operations = options.operations;
  }

  /**
   * Send one attach, and publish what came back.
   *
   * Does not overlap itself. A second press while one attach is on the wire would put two
   * attaches up for one intent, and the second would fail against the first's own work.
   */
  public async attach(localPath: string): Promise<void> {
    await this.act(
      async () => await this.#operations.attachRepository({ localPath }),
      (response: RepoAttachResponse) => ({ status: "attached" as const, response }),
    );
  }
}
