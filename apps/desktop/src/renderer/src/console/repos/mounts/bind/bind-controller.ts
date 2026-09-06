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
// AND ONCE MADE IT GOES THROUGH THE CONSOLE'S ONE SCHEDULER. `Spec-023 §Rules every
// console surface obeys` admits four reasons to read again and forbids interval
// polling, so this class hands itself to a `SessionRefreshTriggers` exactly as the
// section's reader does. What a mount admits changes when the mount does, which is why
// the census it declares is this family's own.
//
// THE SETTLEMENT IS PUBLISHED ON BOTH ARMS. A writable bind answers `provisioning` with
// no root at all — the execution root does not exist yet — and a `read-only` bind
// answers with its root on the same reply. Both are settlements a person reads, and a
// dialog that closed on the press would report the refusal as a success.

import { useCallback, useMemo, useSyncExternalStore } from "react";

import type {
  ExecutionMode,
  RepoMountId,
  WorkspaceBindResponse,
  WorkspaceExecutionModeCapabilitiesReadResponse,
} from "@ai-sidekicks/contracts";

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
import { REPO_LIFECYCLE_EVENT_KINDS } from "../../repo-lifecycle-events.js";
import {
  bindWorkspace,
  readMountExecutionModeCapabilities,
  REPO_READS_REFUSAL_ORIGIN,
} from "../../repo-reads.js";

/** Where the pre-bind capabilities read stands, in the four states rule 8 keeps apart. */
export type BindCapabilitiesReading =
  | { readonly status: "not-read" }
  | { readonly status: "reading" }
  | {
      readonly status: "read";
      readonly capabilities: WorkspaceExecutionModeCapabilitiesReadResponse;
    }
  | { readonly status: "refused"; readonly refusal: ConsoleRefusal };

/** Where the bind itself stands. */
export type BindActReading =
  | { readonly status: "idle" }
  | { readonly status: "sending" }
  | { readonly status: "bound"; readonly response: WorkspaceBindResponse }
  | { readonly status: "refused"; readonly refusal: ConsoleRefusal };

/** Both readings, published together so a surface renders one consistent frame. */
export interface BindReading {
  readonly capabilities: BindCapabilitiesReading;
  readonly act: BindActReading;
}

/** What one bind controller is scoped to: a mount, its session, and the clock. */
export interface BindControllerOptions {
  readonly bridge: ConsoleBridge;
  readonly repoMountId: string;
  /** The session whose reconnect edge and repo frames re-ask the pre-bind question. */
  readonly sessionStore: SessionStore;
  /** The window's one clock, so this refresh coalesces on the section's time base. */
  readonly clock: ConsoleClock;
}

/** Nothing asked and nothing sent. */
export const BIND_NOT_STARTED: BindReading = {
  capabilities: { status: "not-read" },
  act: { status: "idle" },
};

/** Reads what a mount admits and sends the bind for it. */
export class BindWorkspaceController implements ReadTriggerTarget {
  /** The frames that change what a mount admits. This family's own census. */
  public readonly triggeringEventKinds: ReadonlySet<string> = new Set<string>(
    REPO_LIFECYCLE_EVENT_KINDS,
  );
  readonly #bridge: ConsoleBridge;
  readonly #repoMountId: string;
  readonly #scheduler: RefreshScheduler;
  readonly #triggers: SessionRefreshTriggers;
  readonly #changes = new Emitter<BindReading>("workspace bind reading");
  #reading: BindReading = BIND_NOT_STARTED;
  #capabilitiesRequested = false;
  #disposed = false;

  public constructor(options: BindControllerOptions) {
    this.#bridge = options.bridge;
    this.#repoMountId = options.repoMountId;
    this.#scheduler = new RefreshScheduler({
      clock: options.clock,
      perform: async () => {
        await this.#performRead();
      },
      onError: (error: unknown) => {
        this.#publish({
          ...this.#reading,
          capabilities: {
            status: "refused",
            refusal: normalizeWireRejection(REPO_READS_REFUSAL_ORIGIN, error),
          },
        });
      },
    });
    this.#triggers = new SessionRefreshTriggers({
      target: this,
      sessionStore: options.sessionStore,
    });
  }

  public get snapshot(): BindReading {
    return this.#reading;
  }

  public get isDisposed(): boolean {
    return this.#disposed;
  }

  public subscribe(sink: (reading: BindReading) => void): Unsubscribe {
    return this.#changes.subscribe(sink);
  }

  /**
   * Ask what this mount admits, because somebody opened the dialog.
   *
   * IDEMPOTENT. A second open re-reads nothing: the answer has not changed because a
   * popup shut, and re-reading on every open would put a call on the wire per glance.
   */
  public requestCapabilities(): void {
    if (this.#capabilitiesRequested || this.#disposed) {
      return;
    }
    this.#capabilitiesRequested = true;
    this.#triggers.start();
    this.requestRead("subscribe");
  }

  /**
   * Ask again, on one of the four reasons the policy admits.
   *
   * ASKS NOTHING BEFORE THE DIALOG HAS BEEN OPENED, on the attach roster's rule: the
   * pre-bind question is asked because a person is binding, so a reconnect arriving
   * while nobody has opened the dialog changes nothing on screen.
   */
  public requestRead(reason: RefreshReason): void {
    if (this.#disposed || !this.#capabilitiesRequested) {
      return;
    }
    if (this.#reading.capabilities.status === "not-read") {
      this.#publish({ ...this.#reading, capabilities: { status: "reading" } });
    }
    this.#scheduler.request(reason);
  }

  /** Ask again after a refused read. The participant-driven one of the four. */
  public retryCapabilities(): void {
    this.requestRead("participant-request");
  }

  /**
   * Send one bind, and publish what came back.
   *
   * REFUSES TO OVERLAP ITSELF, on the attach controller's reason: a second press while
   * one bind is on the wire binds a second workspace for one intent.
   */
  public async bind(executionMode: ExecutionMode, directory: string | undefined): Promise<void> {
    if (this.#reading.act.status === "sending" || this.#disposed) {
      return;
    }
    this.#publish({ ...this.#reading, act: { status: "sending" } });
    const reply = await bindWorkspace(this.#bridge, {
      repoMountId: this.#repoMountId as RepoMountId,
      executionMode,
      // OMITTED AND NOT EMPTIED. The absent member means the mount root; an empty
      // string is a path of no characters, which the parser refuses.
      ...(directory === undefined ? {} : { directory }),
    });
    if (this.#disposed) {
      return;
    }
    this.#publish({
      ...this.#reading,
      act:
        reply.status === "refused"
          ? { status: "refused", refusal: reply.refusal }
          : { status: "bound", response: reply.value },
    });
  }

  /** Put the act half back to idle. The read half is deliberately untouched. */
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

  async #performRead(): Promise<void> {
    const reply = await readMountExecutionModeCapabilities(
      this.#bridge,
      this.#repoMountId as RepoMountId,
    );
    if (this.#disposed) {
      return;
    }
    this.#publish({
      ...this.#reading,
      capabilities:
        reply.status === "refused"
          ? { status: "refused", refusal: reply.refusal }
          : { status: "read", capabilities: reply.value },
    });
  }

  #publish(reading: BindReading): void {
    this.#reading = reading;
    this.#changes.emit(reading);
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
  const { value: controller } = useSubjectScopedResource(
    bridge,
    repoMountId,
    () => new BindWorkspaceController({ bridge, repoMountId, sessionStore, clock }),
    BIND_CONTROLLER_DISPOSAL,
  );
  const subscribe = useCallback(
    (onReadingChange: () => void) => controller.subscribe(onReadingChange),
    [controller],
  );
  const read = useCallback(() => controller.snapshot, [controller]);
  const reading = useSyncExternalStore(subscribe, read, read);
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

/** How one controller ends, and how one already ended is recognised. */
const BIND_CONTROLLER_DISPOSAL: SubjectScopedDisposal<BindWorkspaceController> = {
  dispose: (controller) => {
    controller.dispose();
  },
  isClosed: (controller) => controller.isDisposed,
};
