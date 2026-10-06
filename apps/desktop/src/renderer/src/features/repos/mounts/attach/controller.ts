// The attach act: the call it sends and how the reply reads. A mount belongs to the machine,
// so the call carries the path and nothing about the session.

import type { RepoAttachResponse } from "@ai-sidekicks/contracts/repo/folders";
import { ActController } from "../../acts/controller.js";
import { type ActSettlementReading } from "../../acts/reading.js";
import type { RepoOperations } from "../../operations.js";

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
   * Send one attach and publish what came back. Does not overlap itself: a second press
   * while one is on the wire would put two attaches up for one intent.
   */
  public async attach(localPath: string): Promise<void> {
    await this.act(
      async () => await this.#operations.attachRepository({ localPath }),
      (response: RepoAttachResponse) => ({ status: "attached" as const, response }),
    );
  }
}
