// Binding a workspace on one mount: the pre-bind read, the act, and what each publishes.
//
// TWO WIRES AND ONE SURFACE, on `attach/attach-controller.ts`'s shape and for its
// reason: the form cannot offer a mode until the mount-scoped capabilities read has
// answered, and that read can be refused while the form is still perfectly fillable.
// Collapsing the two would report a capabilities outage as a bind failure.
//
// THE READ IS MADE WHEN THE DIALOG OPENS AND NOT WHEN THE CARD MOUNTS. A session with
// six mounts would otherwise put six pre-bind reads on the wire for a person who is not
// binding anything, and every one of them is a question about a workspace that does not
// exist yet.
//
// WHAT A MOUNT ADMITS CHANGES WHEN THE MOUNT DOES, which is why the census this reading
// declares is this family's own rather than a list written in this module.
//
// THE SETTLEMENT IS PUBLISHED ON BOTH ARMS. A writable bind answers `provisioning` with
// no root at all — the execution root does not exist yet — and a `read-only` bind
// answers with its root on the same reply. Both are settlements a person reads, and a
// dialog that closed on the press would report the refusal as a success.
//
// EVERYTHING ELSE IS `store/act-controller-base.ts`'S, on the attach controller's note:
// the scheduler, the triggers, the arms, the single-flight guard, the disposed latch,
// and the six members a surface reads them by were written three times in this
// directory and are now written once.

import { useCallback, useMemo } from "react";

import type {
  ExecutionMode,
  RepoMountId,
  WorkspaceBindResponse,
  WorkspaceExecutionModeCapabilitiesReadResponse,
} from "@ai-sidekicks/contracts";

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
import { REPO_LIFECYCLE_EVENT_KINDS } from "../../repo-lifecycle-events.js";
import {
  bindWorkspace,
  readMountExecutionModeCapabilities,
  REPO_READS_REFUSAL_ORIGIN,
} from "../../repo-reads.js";

/** What a finished bind carries: the workspace the daemon bound, in whatever state. */
export interface BindSettlement {
  readonly status: "bound";
  readonly response: WorkspaceBindResponse;
}

/** Where the pre-bind capabilities read stands, in the four states rule 8 keeps apart. */
export type BindCapabilitiesReading =
  ActPrerequisiteReading<WorkspaceExecutionModeCapabilitiesReadResponse>;

/** Where the bind itself stands. */
export type BindActReading = ActSettlementReading<BindSettlement>;

/** Both halves, published together so a surface renders one consistent frame. */
export type BindReading = ActReading<
  WorkspaceExecutionModeCapabilitiesReadResponse,
  BindSettlement
>;

/** What one bind controller is scoped to: a mount, its session, and the clock. */
export interface BindControllerOptions {
  readonly bridge: ConsoleBridge;
  readonly repoMountId: string;
  /** The session whose reconnect edge and repo frames re-ask the pre-bind question. */
  readonly sessionStore: SessionStore;
  /** The window's one clock, so this refresh coalesces on the section's time base. */
  readonly clock: ConsoleClock;
}

/**
 * The pre-bind question, named once.
 *
 * A CONSTANT for the roster question's reason: there is one of it per controller, and
 * the controller is already scoped to the mount it asks about. Its stability is what
 * keeps a reopened dialog off the wire.
 */
const CAPABILITIES_QUESTION = "capabilities";

/** Reads what a mount admits and sends the bind for it. */
export class BindWorkspaceController extends ActSurfaceController<
  WorkspaceExecutionModeCapabilitiesReadResponse,
  BindSettlement
> {
  readonly #bridge: ConsoleBridge;
  readonly #repoMountId: string;

  public constructor(options: BindControllerOptions) {
    super({
      label: "workspace bind reading",
      clock: options.clock,
      sessionStore: options.sessionStore,
      // The frames that change what a mount admits. This family's own census.
      triggeringEventKinds: new Set<string>(REPO_LIFECYCLE_EVENT_KINDS),
      refusalOrigin: REPO_READS_REFUSAL_ORIGIN,
    });
    this.#bridge = options.bridge;
    this.#repoMountId = options.repoMountId;
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

  /** Ask again after a refused read. The participant-driven one of the four. */
  public retryCapabilities(): void {
    this.retryPrerequisite();
  }

  /**
   * Send one bind, and publish what came back.
   *
   * REFUSES TO OVERLAP ITSELF, on the attach controller's reason: a second press while
   * one bind is on the wire binds a second workspace for one intent.
   */
  public async bind(executionMode: ExecutionMode, directory: string | undefined): Promise<void> {
    await this.sendAct(
      async () =>
        await bindWorkspace(this.#bridge, {
          repoMountId: this.#repoMountId as RepoMountId,
          executionMode,
          // OMITTED AND NOT EMPTIED. The absent member means the mount root; an empty
          // string is a path of no characters, which the parser refuses.
          ...(directory === undefined ? {} : { directory }),
        }),
      (response: WorkspaceBindResponse) => ({ status: "bound" as const, response }),
    );
  }

  /** The pre-bind capabilities call, asked for the mount this controller is scoped to. */
  protected override async readPrerequisite(): Promise<
    ActOutcome<WorkspaceExecutionModeCapabilitiesReadResponse>
  > {
    return await readMountExecutionModeCapabilities(this.#bridge, this.#repoMountId as RepoMountId);
  }
}

/** What the hook hands a surface: the reading, and the four things it can ask for. */
export interface BindBinding {
  readonly reading: BindReading;
  readonly requestCapabilities: () => void;
  readonly retryCapabilities: () => void;
  readonly bind: (executionMode: ExecutionMode, directory: string | undefined) => void;
  readonly clearAct: () => void;
}

/**
 * Bind one mount's bind controller to a surface.
 *
 * KEYED ON THE MOUNT, which is the whole of what the read and the act are scoped to.
 */
export function useBindController(
  bridge: ConsoleBridge,
  repoMountId: string,
  sessionStore: SessionStore,
): BindBinding {
  // One window, one time base, memoised so a fresh clock per render does not re-mint
  // the controller beneath it.
  const clock = useMemo(() => consoleClockFor(bridge), [bridge]);
  const { controller, reading } = useActController(
    bridge,
    repoMountId,
    () => new BindWorkspaceController({ bridge, repoMountId, sessionStore, clock }),
  );
  const requestCapabilities = useCallback(() => {
    controller.requestCapabilities();
  }, [controller]);
  const retryCapabilities = useCallback(() => {
    controller.retryCapabilities();
  }, [controller]);
  const bind = useCallback(
    (executionMode: ExecutionMode, directory: string | undefined) => {
      void controller.bind(executionMode, directory);
    },
    [controller],
  );
  const clearAct = useCallback(() => {
    controller.clearAct();
  }, [controller]);
  return { reading, requestCapabilities, retryCapabilities, bind, clearAct };
}
