// The attach act: the call it sends, and what it publishes.
//
// Everything but the call is the store's act controller: the scheduler, the act arms, the
// single-flight guard, the disposed latch, and the members a surface reads them by. What is
// left here is what is attach's own, which call it makes and how the reply reads.
//
// Attach asks nothing first. The base class carries a prerequisite question that the bind
// and prepare controllers use; this one never names a question, so its prerequisite is
// never read.

import { useCallback, useMemo } from "react";

import type { RepoAttachResponse } from "@ai-sidekicks/contracts";

import { consoleClockFor, type ConsoleBridge } from "../../../bridge/index.js";
import type { ConsoleClock } from "../../../core/index.js";
import {
  ActSurfaceController,
  useActController,
  type ActOutcome,
  type ActReading,
  type ActSettlementReading,
  type SessionStore,
} from "../../../store/index.js";
import { REPO_REFUSAL_ORIGIN, type RepoOperations } from "../../repo-operations.js";

/** What a finished attach carries: the mount the daemon minted for it. */
export interface AttachSettlement {
  readonly status: "attached";
  readonly response: RepoAttachResponse;
}

/** Where the attach itself stands. */
export type AttachActReading = ActSettlementReading<AttachSettlement>;

/** What a surface renders: the settlement, beside a prerequisite that is never read. */
export type AttachReading = ActReading<void, AttachSettlement>;

/** What one attach controller is scoped to: a session, and the window's clock. */
export interface AttachControllerOptions {
  readonly operations: Pick<RepoOperations, "attachRepository">;
  readonly sessionStore: SessionStore;
  /** The window's one clock, so a settlement is stamped on the section's time base. */
  readonly clock: ConsoleClock;
}

/** What the hook hands a dialog: the reading, and the two things it can ask for. */
export interface AttachBinding {
  readonly reading: AttachReading;
  readonly attach: (localPath: string) => void;
  readonly clearAct: () => void;
}

/** Sends the attach for one session. */
export class AttachController extends ActSurfaceController<void, AttachSettlement> {
  readonly #operations: Pick<RepoOperations, "attachRepository">;
  readonly #sessionId: string;

  public constructor(options: AttachControllerOptions) {
    super({
      label: "repository attach reading",
      clock: options.clock,
      sessionStore: options.sessionStore,
      triggeringEventKinds: new Set<string>(),
      refusalOrigin: REPO_REFUSAL_ORIGIN,
    });
    this.#operations = options.operations;
    this.#sessionId = options.sessionStore.sessionId;
  }

  /**
   * Send one attach, and publish what came back.
   *
   * Does not overlap itself. A second press while one attach is on the wire would put two
   * attaches up for one intent, and the second would fail against the first's own work.
   */
  public async attach(localPath: string): Promise<void> {
    await this.sendAct(
      async () => ({
        status: "served" as const,
        value: await this.#operations.attachRepository({ sessionId: this.#sessionId, localPath }),
      }),
      (response: RepoAttachResponse) => ({ status: "attached" as const, response }),
    );
  }

  protected override readPrerequisite(): Promise<ActOutcome<void>> {
    return Promise.resolve({ status: "served", value: undefined });
  }
}

/** Bind one session's attach controller to a surface. */
export function useAttachController(
  bridge: ConsoleBridge,
  sessionStore: SessionStore,
  operations: Pick<RepoOperations, "attachRepository">,
): AttachBinding {
  const clock = useMemo(() => consoleClockFor(bridge), [bridge]);
  const { controller, reading } = useActController(
    bridge,
    sessionStore.sessionId,
    sessionStore,
    () => new AttachController({ operations, sessionStore, clock }),
  );
  const attach = useCallback(
    (localPath: string) => {
      void controller.attach(localPath);
    },
    [controller],
  );
  const clearAct = useCallback(() => {
    controller.clearAct();
  }, [controller]);
  return { reading, attach, clearAct };
}
