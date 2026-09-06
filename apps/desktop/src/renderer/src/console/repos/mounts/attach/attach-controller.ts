// The attach act: the roster it picks a node from, the call it sends, and what it
// publishes on both arms.
//
// TWO WIRES AND ONE SURFACE. Attaching needs the session's runtime-node roster before
// it can name a node, and `runtimenode.roster` is a different call from `repo.attach`
// with a different failure. So this controller holds two readings rather than one: a
// roster read that can be refused while the form is still perfectly fillable, and an
// attach that can be refused while the roster is fine. Collapsing them would report a
// roster outage as an attach failure.
//
// THE ROSTER READ IS MADE WHEN THE DIALOG OPENS AND NOT WHEN THE SECTION MOUNTS. A
// person who never attaches never asks the question, and a read on section mount would
// put a call on the wire for every session that merely looked at its repositories.
//
// AND ONCE IT HAS BEEN MADE IT GOES THROUGH THE CONSOLE'S ONE SCHEDULER. `Spec-023
// §Rules every console surface obeys` admits four reasons to read again and forbids
// interval polling, so this class hands itself to a `SessionRefreshTriggers` exactly as
// `repo-mounts-reader.ts` does. A dialog left open across a reconnect would otherwise
// be offering a node list read before the connection dropped — which is the one state
// where a person picks a machine that is no longer there.
//
// ITS TRIGGERING KINDS ARE THE RUNTIME-NODE ONES AND NOT THIS FAMILY'S. What changes a
// roster is a node attaching, detaching, or going offline, and none of those is a repo
// frame — so this reading declares the node census and the mounts reader declares the
// repo one, which is what `ReadTriggerTarget` means by making the set a property of the
// QUESTION rather than of the surface.
//
// THE SETTLEMENT IS PUBLISHED, NEVER SWALLOWED, ON BOTH ARMS. `Spec-023 §Rules every
// console surface obeys` admits no silent no-op: an attach that succeeded says which
// mount it minted, and one that was refused renders the daemon's own code with the
// recovery this family has for it. A dialog that closed on both would leave the second
// case looking like the first.
//
// THE HOOK LIVES HERE BESIDE THE CLASS, on `attachments/attachment-carrier.ts`'s
// precedent: the binding is nine lines of lifecycle over one constructor, and the
// split `proposal-gate-binding.ts` makes is a split this module's size does not earn.

import { useCallback, useMemo, useSyncExternalStore } from "react";

import type { NodeId, RepoAttachResponse, RuntimeNodeRosterEntry } from "@ai-sidekicks/contracts";

import { consoleClockFor, type ConsoleBridge } from "../../../bridge/index.js";
import {
  Emitter,
  normalizeWireRejection,
  type ConsoleClock,
  type ConsoleRefusal,
  type Unsubscribe,
} from "../../../core/index.js";
import {
  RefreshScheduler,
  SessionRefreshTriggers,
  useSubjectScopedResource,
  type ReadTriggerTarget,
  type RefreshReason,
  type SessionStore,
  type SubjectScopedDisposal,
} from "../../../store/index.js";
import { RUNTIME_NODE_ROSTER_EVENT_KINDS } from "./attach-model.js";
import {
  attachRepository,
  forwardedSessionId,
  REPO_READS_REFUSAL_ORIGIN,
} from "../../repo-reads.js";
import { attachNodeOptions, type AttachNodeOption } from "./attach-model.js";

/** Where the roster read stands, in the four states rule 8 keeps apart. */
export type AttachRosterReading =
  | { readonly status: "not-read" }
  | { readonly status: "reading" }
  | { readonly status: "read"; readonly options: readonly AttachNodeOption[] }
  | { readonly status: "refused"; readonly refusal: ConsoleRefusal };

/** Where the attach itself stands. */
export type AttachActReading =
  | { readonly status: "idle" }
  | { readonly status: "sending" }
  | { readonly status: "attached"; readonly response: RepoAttachResponse }
  | { readonly status: "refused"; readonly refusal: ConsoleRefusal };

/** Both readings, published together so a surface renders one consistent frame. */
export interface AttachReading {
  readonly roster: AttachRosterReading;
  readonly act: AttachActReading;
}

/** What one attach controller is scoped to: a session, and the window's clock. */
export interface AttachControllerOptions {
  readonly bridge: ConsoleBridge;
  /** The session attached to, and the source of this reading's refresh triggers. */
  readonly sessionStore: SessionStore;
  /** The window's one clock, so this refresh coalesces on the section's time base. */
  readonly clock: ConsoleClock;
}

/** Nothing asked and nothing sent. */
export const ATTACH_NOT_STARTED: AttachReading = {
  roster: { status: "not-read" },
  act: { status: "idle" },
};

/**
 * Reads the roster and sends the attach for one session.
 *
 * ONE CONTROLLER PER SESSION AND NOT PER DIALOG, which is why the roster survives a
 * dialog that is closed and reopened: the answer has not changed because a popup shut,
 * and re-reading on every open would put a call on the wire for each glance.
 */
export class AttachController implements ReadTriggerTarget {
  /** The frames that change a session's node roster. See the header for why not repo ones. */
  public readonly triggeringEventKinds: ReadonlySet<string> = RUNTIME_NODE_ROSTER_EVENT_KINDS;
  readonly #bridge: ConsoleBridge;
  readonly #sessionId: string;
  readonly #scheduler: RefreshScheduler;
  readonly #triggers: SessionRefreshTriggers;
  readonly #changes = new Emitter<AttachReading>("repository attach reading");
  #reading: AttachReading = ATTACH_NOT_STARTED;
  #rosterRequested = false;
  #disposed = false;

  public constructor(options: AttachControllerOptions) {
    this.#bridge = options.bridge;
    this.#sessionId = options.sessionStore.sessionId;
    this.#scheduler = new RefreshScheduler({
      clock: options.clock,
      perform: async () => {
        await this.#performRosterRead();
      },
      // A read that threw past its own handling reaches nobody from a scheduler
      // callback, so it lands in the reading as a refusal the dialog renders.
      onError: (error: unknown) => {
        this.#publishRosterRejection(error);
      },
    });
    this.#triggers = new SessionRefreshTriggers({
      target: this,
      sessionStore: options.sessionStore,
    });
  }

  public get snapshot(): AttachReading {
    return this.#reading;
  }

  public get isDisposed(): boolean {
    return this.#disposed;
  }

  public subscribe(sink: (reading: AttachReading) => void): Unsubscribe {
    return this.#changes.subscribe(sink);
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
    if (this.#rosterRequested || this.#disposed) {
      return;
    }
    this.#rosterRequested = true;
    this.#triggers.start();
    this.requestRead("subscribe");
  }

  /**
   * Ask again, on one of the four reasons the policy admits.
   *
   * IT ASKS NOTHING BEFORE THE DIALOG HAS BEEN OPENED, which is the one thing that
   * separates this reading from the section's: the roster is read because a person is
   * attaching, so a reconnect arriving while nobody has opened the dialog changes
   * nothing that is on screen and puts no call on the wire.
   */
  public requestRead(reason: RefreshReason): void {
    if (this.#disposed || !this.#rosterRequested) {
      return;
    }
    if (this.#reading.roster.status === "not-read") {
      this.#publish({ ...this.#reading, roster: { status: "reading" } });
    }
    this.#scheduler.request(reason);
  }

  /** Ask again after a refused roster read. The participant-driven one of the four. */
  public retryRoster(): void {
    this.requestRead("participant-request");
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
    if (this.#reading.act.status === "sending" || this.#disposed) {
      return;
    }
    this.#publish({ ...this.#reading, act: { status: "sending" } });
    const reply = await attachRepository(
      this.#bridge,
      this.#sessionId,
      localPath,
      nodeId as NodeId,
    );
    if (this.#disposed) {
      return;
    }
    this.#publish({
      ...this.#reading,
      act:
        reply.status === "refused"
          ? { status: "refused", refusal: reply.refusal }
          : { status: "attached", response: reply.value },
    });
  }

  /**
   * Put the act half back to idle.
   *
   * ITS OWN CALL RATHER THAN A SIDE EFFECT OF CLOSING, because the two are different
   * moments: a settlement is read after the call settles and the dialog is still open,
   * and a participant who reopens the dialog to attach a second repository must not
   * meet the first one's success sentence. The roster half is deliberately untouched.
   */
  public clearAct(): void {
    if (this.#reading.act.status === "idle") {
      return;
    }
    this.#publish({ ...this.#reading, act: { status: "idle" } });
  }

  public dispose(): void {
    this.#disposed = true;
    this.#scheduler.dispose();
    this.#triggers.dispose();
    this.#changes.clear();
  }

  async #performRosterRead(): Promise<void> {
    let entries: readonly RuntimeNodeRosterEntry[];
    try {
      const outcome = await this.#bridge.runtimeNodeRosterRead({
        sessionId: forwardedSessionId(this.#sessionId),
      });
      if (this.#disposed) {
        return;
      }
      if (outcome.status === "refused") {
        this.#publish({ ...this.#reading, roster: { status: "refused", refusal: outcome } });
        return;
      }
      entries = outcome.value.nodes;
    } catch (rejection) {
      if (this.#disposed) {
        return;
      }
      // A REJECTION IS AN ANSWER TOO. The live bridge crosses a process boundary, so a
      // disconnected namespace throws where the fixture answers a refusal; without this
      // arm the dialog would sit on `reading` with no roster and no reason for it.
      this.#publishRosterRejection(rejection);
      return;
    }
    this.#publish({
      ...this.#reading,
      roster: { status: "read", options: attachNodeOptions(entries) },
    });
  }

  /** One rejection reading, for the two paths that can produce one. */
  #publishRosterRejection(rejection: unknown): void {
    this.#publish({
      ...this.#reading,
      roster: {
        status: "refused",
        refusal: normalizeWireRejection(REPO_READS_REFUSAL_ORIGIN, rejection, {
          code: "call-rejected",
          detail: "The runtime-node roster read did not complete.",
        }),
      },
    });
  }

  #publish(reading: AttachReading): void {
    this.#reading = reading;
    this.#changes.emit(reading);
  }
}

/** What the hook hands a dialog: the reading, and the three things it can ask for. */
export interface AttachBinding {
  readonly reading: AttachReading;
  readonly requestRoster: () => void;
  readonly retryRoster: () => void;
  readonly attach: (localPath: string, nodeId: string) => void;
  readonly clearAct: () => void;
}

/**
 * Bind one session's attach controller to a surface.
 *
 * Held by `useSubjectScopedResource` rather than `useMemo`, for the reason that seam
 * exists: a controller constructed during a render React then discards is a real
 * object with a real read on the wire that no effect ever commits to end.
 */
export function useAttachController(
  bridge: ConsoleBridge,
  sessionStore: SessionStore,
): AttachBinding {
  const clock = useMemo(() => consoleClockFor(bridge), [bridge]);
  const { value: controller } = useSubjectScopedResource(
    bridge,
    sessionStore.sessionId,
    () => new AttachController({ bridge, sessionStore, clock }),
    ATTACH_CONTROLLER_DISPOSAL,
  );
  const subscribe = useCallback(
    (onReadingChange: () => void) => controller.subscribe(onReadingChange),
    [controller],
  );
  const read = useCallback(() => controller.snapshot, [controller]);
  const reading = useSyncExternalStore(subscribe, read, read);
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

/** How one controller ends, and how one already ended is recognised. See the gate's. */
const ATTACH_CONTROLLER_DISPOSAL: SubjectScopedDisposal<AttachController> = {
  dispose: (controller) => {
    controller.dispose();
  },
  isClosed: (controller) => controller.isDisposed,
};
