// Binding a workspace on one mount: the pre-bind read, the act, and what each publishes.
//
// Two calls and one surface: the form cannot offer a mode until the mount-scoped
// capabilities read has answered, and the two are asked and published separately.
//
// The read is made when the dialog opens and not when the card mounts. A session with six
// mounts would otherwise put six pre-bind reads on the wire for a person who is not binding
// anything.
//
// What a mount admits changes when the mount does, which is why the frames this reading
// re-asks on are this family's own census rather than a list written in this module.
//
// A bind answers with the mode it bound and the workspace's lifecycle state, and no root:
// the workspace list is where a root is read from once it exists.
//
// A mount belongs to the machine, so the bind names the session the new workspace belongs
// to; the controller is scoped to that session's store.
//
// Everything else is the store's act controller: the scheduler, the triggers, the act arms,
// the single-flight guard, the disposed latch, and the members a surface reads them by.

import type {
  ExecutionMode,
  RepoMountId,
  SessionId,
  WorkspaceBindResponse,
  WorkspaceExecutionModeCapabilitiesReadResponse,
} from "@ai-sidekicks/contracts";
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

/** Both halves, published together so a surface renders one consistent frame. */
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
  /** The window's one clock, so this refresh coalesces on the section's time base. */
  readonly clock: Clock;
}

/** The two calls this controller makes. */
type BindOperations = Pick<RepoOperations, "bindWorkspace" | "readMountExecutionModes">;

/**
 * The pre-bind question, named once.
 *
 * A CONSTANT because there is one question per controller, and the controller is already
 * scoped to the mount it asks about. Its stability is what keeps a reopened dialog off the
 * wire.
 */
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
      // The frames that change what a mount admits. This family's own census.
      triggeringEventKinds: new Set<string>(REPO_LIFECYCLE_EVENT_KINDS),
    });
    this.#operations = options.operations;
    this.#repoMountId = options.repoMountId;
    this.#sessionId = options.sessionStore.sessionId;
  }

  /**
   * Ask what this mount admits, because somebody opened the dialog.
   *
   * IDEMPOTENT. A second open re-reads nothing: the answer has not changed because a
   * popup shut, and re-reading on every open would put a call on the wire per glance.
   */
  public requestCapabilities(): void {
    this.askPrerequisite(CAPABILITIES_QUESTION, "subscribe");
  }

  /**
   * Send one bind, and publish what came back.
   *
   * Does not overlap itself: a second press while one bind is on the wire would bind a
   * second workspace for one intent.
   */
  public async bind(executionMode: ExecutionMode, directory: string | undefined): Promise<void> {
    await this.sendAct(
      async () =>
        await this.#operations.bindWorkspace({
          sessionId: this.#sessionId as SessionId,
          repoMountId: this.#repoMountId as RepoMountId,
          executionMode,
          // Omitted and not emptied. The absent member means the mount root; an empty
          // string is a path of no characters, which the parser refuses.
          ...(directory === undefined ? {} : { directory }),
        }),
      (response: WorkspaceBindResponse) => ({ status: "bound" as const, response }),
    );
  }

  /**
   * The pre-bind capabilities call, asked for the mount this controller is scoped to.
   *
   * The round's signal goes straight to the call, so a dialog closed while this read is
   * on the wire drops the reply rather than folding an answer for a form nobody is
   * filling in.
   */
  protected override async readPrerequisite(
    _question: string,
    signal: AbortSignal,
  ): Promise<WorkspaceExecutionModeCapabilitiesReadResponse> {
    return await this.#operations.readMountExecutionModes(this.#repoMountId as RepoMountId, signal);
  }
}
