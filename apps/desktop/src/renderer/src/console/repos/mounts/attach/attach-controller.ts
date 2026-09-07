// The attach act: the roster it picks a node from, the call it sends, and what it
// publishes on both arms.
//
// TWO WIRES AND ONE SURFACE. Attaching needs the session's runtime-node roster before
// it can name a node, and `runtimenode.roster` is a different call from `repo.attach`
// with a different failure. So this controller holds two halves rather than one: a
// roster read that can be refused while the form is still perfectly fillable, and an
// attach that can be refused while the roster is fine. Collapsing them would report a
// roster outage as an attach failure.
//
// THE ROSTER READ IS MADE WHEN THE DIALOG OPENS AND NOT WHEN THE SECTION MOUNTS. A
// person who never attaches never asks the question, and a read on section mount would
// put a call on the wire for every session that merely looked at its repositories.
//
// ITS TRIGGERING KINDS ARE THE RUNTIME-NODE ONES AND NOT THIS FAMILY'S. What changes a
// roster is a node attaching, detaching, or going offline, and none of those is a repo
// frame — so this reading declares the node census and the mounts reader declares the
// repo one, which is what `ReadTriggerTarget` means by making the set a property of the
// QUESTION rather than of the surface.
//
// EVERYTHING ELSE IS `store/act-controller-base.ts`'S. The scheduler, the trigger
// wiring, the four read arms, the four act arms, the single-flight guard, the disposed
// latch, and the six members a surface reads them by were written here, in
// `bind/bind-controller.ts`, and in `roots/prepare-controller.ts` three times over;
// what is left in this module is what is genuinely attach's — which two calls it
// makes, and how each reply reads.

import { useCallback, useMemo } from "react";

import type { NodeId, RepoAttachResponse } from "@ai-sidekicks/contracts";

import { consoleClockFor, type ConsoleBridge } from "../../../bridge/index.js";
import type { ConsoleClock } from "../../../core/index.js";
import {
  ActSurfaceController,
  useActController,
  type ActOutcome,
  type ActPrerequisiteReading,
  type ActReading,
  type ActSettlementReading,
  type SessionStore,
} from "../../../store/index.js";
import {
  attachRepository,
  forwardedSessionId,
  REPO_READS_REFUSAL_ORIGIN,
} from "../../repo-reads.js";
import {
  attachNodeOptions,
  RUNTIME_NODE_ROSTER_EVENT_KINDS,
  type AttachNodeOption,
} from "./attach-model.js";

/** What a finished attach carries: the mount the daemon minted for it. */
export interface AttachSettlement {
  readonly status: "attached";
  readonly response: RepoAttachResponse;
}

/** Where the roster read stands, in the four states rule 8 keeps apart. */
export type AttachRosterReading = ActPrerequisiteReading<readonly AttachNodeOption[]>;

/** Where the attach itself stands. */
export type AttachActReading = ActSettlementReading<AttachSettlement>;

/** Both halves, published together so a surface renders one consistent frame. */
export type AttachReading = ActReading<readonly AttachNodeOption[], AttachSettlement>;

/** What one attach controller is scoped to: a session, and the window's clock. */
export interface AttachControllerOptions {
  readonly bridge: ConsoleBridge;
  /** The session attached to, and the source of this reading's refresh triggers. */
  readonly sessionStore: SessionStore;
  /** The window's one clock, so this refresh coalesces on the section's time base. */
  readonly clock: ConsoleClock;
}

/**
 * The roster question, named once.
 *
 * A CONSTANT AND NOT A VALUE READ OFF THE SESSION, because there is exactly one roster
 * question per controller and the controller is already scoped to the session. What
 * makes the string matter is only that it is STABLE: re-asking the same question is
 * the no-op that keeps a reopened dialog off the wire.
 */
const ROSTER_QUESTION = "roster";

/**
 * Reads the roster and sends the attach for one session.
 *
 * ONE CONTROLLER PER SESSION AND NOT PER DIALOG, which is why the roster survives a
 * dialog that is closed and reopened: the answer has not changed because a popup shut,
 * and re-reading on every open would put a call on the wire for each glance.
 */
export class AttachController extends ActSurfaceController<
  readonly AttachNodeOption[],
  AttachSettlement
> {
  readonly #bridge: ConsoleBridge;
  readonly #sessionId: string;

  public constructor(options: AttachControllerOptions) {
    super({
      label: "repository attach reading",
      clock: options.clock,
      sessionStore: options.sessionStore,
      // The frames that change a session's node roster. See the header for why not
      // repo ones.
      triggeringEventKinds: RUNTIME_NODE_ROSTER_EVENT_KINDS,
      refusalOrigin: REPO_READS_REFUSAL_ORIGIN,
      readRejection: {
        code: "call-rejected",
        detail: "The runtime-node roster read did not complete.",
      },
    });
    this.#bridge = options.bridge;
    this.#sessionId = options.sessionStore.sessionId;
  }

  /**
   * Read the roster once, for the dialog that just opened.
   *
   * IDEMPOTENT, and re-armed by nothing: a second open re-reads nothing, and a refused
   * read stays refused until the dialog's own retry asks again. That retry is the
   * participant-driven refresh `Spec-023 §Rules every console surface obeys` admits,
   * which is why it is a control and not a timer.
   */
  public requestRoster(): void {
    this.askPrerequisite(ROSTER_QUESTION, "subscribe");
  }

  /** Ask again after a refused roster read. The participant-driven one of the four. */
  public retryRoster(): void {
    this.retryPrerequisite();
  }

  /**
   * Send one attach, and publish what came back.
   *
   * REFUSES TO OVERLAP ITSELF. A second press while one attach is on the wire would
   * put two `repo.attach` calls up for one intent, and the active-root uniqueness index
   * means the second refuses `repo.already_attached` against the first's own work —
   * which reads, on screen, as the attach having failed.
   */
  public async attach(localPath: string, nodeId: string): Promise<void> {
    await this.sendAct(
      async () =>
        await attachRepository(this.#bridge, this.#sessionId, localPath, nodeId as NodeId),
      (response: RepoAttachResponse) => ({ status: "attached" as const, response }),
    );
  }

  /** The roster call, and the mapping from wire entries to the rows a picker draws. */
  protected override async readPrerequisite(): Promise<ActOutcome<readonly AttachNodeOption[]>> {
    const outcome = await this.#bridge.runtimeNodeRosterRead({
      sessionId: forwardedSessionId(this.#sessionId),
    });
    // THE ROSTER PORT ANSWERS WITH THE REFUSAL ITSELF where the call wrappers in
    // `repo-reads.ts` answer with one wrapped in an outcome, so this is the one call
    // in the family that has to say which arm it is holding.
    return outcome.status === "refused"
      ? { status: "refused", refusal: outcome }
      : { status: "served", value: attachNodeOptions(outcome.value.nodes) };
  }
}

/** What the hook hands a dialog: the reading, and the four things it can ask for. */
export interface AttachBinding {
  readonly reading: AttachReading;
  readonly requestRoster: () => void;
  readonly retryRoster: () => void;
  readonly attach: (localPath: string, nodeId: string) => void;
  readonly clearAct: () => void;
}

/** Bind one session's attach controller to a surface. */
export function useAttachController(
  bridge: ConsoleBridge,
  sessionStore: SessionStore,
): AttachBinding {
  const clock = useMemo(() => consoleClockFor(bridge), [bridge]);
  const { controller, reading } = useActController(
    bridge,
    sessionStore.sessionId,
    () => new AttachController({ bridge, sessionStore, clock }),
  );
  const requestRoster = useCallback(() => {
    controller.requestRoster();
  }, [controller]);
  const retryRoster = useCallback(() => {
    controller.retryRoster();
  }, [controller]);
  const attach = useCallback(
    (localPath: string, nodeId: string) => {
      void controller.attach(localPath, nodeId);
    },
    [controller],
  );
  const clearAct = useCallback(() => {
    controller.clearAct();
  }, [controller]);
  return { reading, requestRoster, retryRoster, attach, clearAct };
}
