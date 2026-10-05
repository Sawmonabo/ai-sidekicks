// Whether this machine's operating system will let the main process raise a notification.
//
// Every window trigger re-reads it, since the person grants the permission outside this
// application; the scheduler serializes probes and the latch drops a reply from a superseded
// round. A probe the machine fails to answer leaves the reading as it was and goes to the
// window's diagnostic capture.
import type { NotificationPermission, Unsubscribe } from "@shared/preload-api.js";
import { useCallback, useSyncExternalStore } from "react";

import { Emitter } from "@renderer/lib/emitter.js";
import { type Clock } from "@renderer/lib/clock.js";
import {
  diagnosticStampAt,
  windowDiagnosticCapture,
} from "@renderer/lib/diagnostic-capture/diagnostic-capture.js";
import { wireRejectionToError } from "@renderer/lib/wire/errors.js";
import { GenerationLatch } from "@renderer/lib/reads/generation-latch.js";
import {
  NO_TRIGGERING_EVENT_KINDS,
  type ReadTriggerTarget,
} from "@renderer/store/reads/read-triggers.js";
import { useWindowReadTriggers } from "@renderer/store/reads/hooks/useWindowReadTriggers.js";
import {
  RefreshScheduler,
  type RefreshReason,
} from "@renderer/lib/reads/refresh/refresh-scheduler.js";
import { useSubjectScopedResource } from "@renderer/hooks/subject-scoped/useSubjectScopedResource.js";
import { type SubjectScopedDisposal } from "@renderer/lib/subject-scoped/subject-scoped-disposal.js";
import { useBridgeClock } from "@renderer/services/platform/hooks/useClock.js";
import { type PlatformBridge } from "@renderer/services/platform/platform-bridge.js";

/** What the machine can answer: the bridge's own permission states. */
export type OsNotificationPermissionState = NotificationPermission["state"];

/** Asks the machine for its notification permission. */
export type OsNotificationPermissionProbe = () => Promise<OsNotificationPermissionState>;

/** Unread until the first probe answers, then the machine's answer unfolded. */
export type OsNotificationPermissionReading =
  | { readonly kind: "unread" }
  | { readonly kind: "read"; readonly state: OsNotificationPermissionState };

const UNREAD: OsNotificationPermissionReading = Object.freeze({ kind: "unread" });

/** The one key every probe of this machine's permission is taken under. */
const OS_PERMISSION_READ_KEY = "os-notification-permission-read";

/** Options for {@link OsNotificationPermissionRead}. */
export interface OsNotificationPermissionReadOptions {
  readonly probe: OsNotificationPermissionProbe;
  /** The clock the scheduler arms on. The fixture's frozen one under a scenario. */
  readonly clock: Clock;
}

/** One machine's notification permission, kept current by the window's triggers. */
export class OsNotificationPermissionRead implements ReadTriggerTarget {
  /** No session event bears on the machine's permission. */
  public readonly triggeringEventKinds: ReadonlySet<string> = NO_TRIGGERING_EVENT_KINDS;
  readonly #probeMachine: OsNotificationPermissionProbe;
  readonly #changes = new Emitter<void>("os notification permission read change");
  readonly #rounds = new GenerationLatch();
  readonly #scheduler: RefreshScheduler;
  #reading: OsNotificationPermissionReading = UNREAD;
  #isDisposed = false;

  public constructor(options: OsNotificationPermissionReadOptions) {
    this.#probeMachine = options.probe;
    this.#scheduler = new RefreshScheduler({
      clock: options.clock,
      perform: async () => {
        await this.#probe();
      },
      onError: (error) => {
        windowDiagnosticCapture.record({
          at: diagnosticStampAt(options.clock),
          severity: "warning",
          source: "features/settings",
          kind: "os-notification-permission-unread",
          detail: wireRejectionToError(error).message,
        });
      },
    });
  }

  /** What a view renders from. One held value, so its identity is stable. */
  public snapshot(): OsNotificationPermissionReading {
    return this.#reading;
  }

  public subscribe(sink: () => void): Unsubscribe {
    return this.#changes.subscribe(sink);
  }

  /** Whether this reading has been disposed. The re-mint its holder takes. */
  public get isDisposed(): boolean {
    return this.#isDisposed;
  }

  /** Ask the machine again. Every window trigger arrives here and none probes. */
  public requestRead(reason: RefreshReason): void {
    if (this.#isDisposed) {
      return;
    }
    this.#scheduler.request(reason);
  }

  /** Terminal. A probe landing after this publishes nothing. */
  public dispose(): void {
    this.#isDisposed = true;
    this.#scheduler.dispose();
    this.#rounds.supersedeAll();
  }

  /** Probe once, and publish only if this round is still the live one. */
  async #probe(): Promise<void> {
    const round = this.#rounds.currentClaim(this, OS_PERMISSION_READ_KEY);
    const state = await this.#probeMachine();
    round.settle(() => {
      this.#publish({ kind: "read", state });
    });
  }

  #publish(reading: OsNotificationPermissionReading): void {
    this.#reading = reading;
    this.#changes.emit();
  }
}

/** How a probe whose bridge moved is retired, declared once at module scope. */
const OS_PERMISSION_READ_DISPOSAL: SubjectScopedDisposal<OsNotificationPermissionRead> = {
  dispose: (read) => {
    read.dispose();
  },
  isClosed: (read) => read.isDisposed,
};

/**
 * Watch this machine's permission, re-read whenever it can have changed.
 *
 * Keyed on the bridge because the subject is the machine, not a session or a user.
 *
 * @consumedBy the Notifications page's permission notice
 */
export function useOsNotificationPermission(
  bridge: PlatformBridge,
  probe: OsNotificationPermissionProbe,
): OsNotificationPermissionReading {
  const clock = useBridgeClock();
  const { value: read } = useSubjectScopedResource(
    bridge,
    undefined,
    () => new OsNotificationPermissionRead({ probe, clock }),
    OS_PERMISSION_READ_DISPOSAL,
  );
  useWindowReadTriggers(read, bridge.transportReconnect);
  const subscribeToRead = useCallback(
    (onStoreChange: () => void) => read.subscribe(onStoreChange),
    [read],
  );
  const takeReadSnapshot = useCallback(() => read.snapshot(), [read]);
  return useSyncExternalStore(subscribeToRead, takeReadSnapshot, takeReadSnapshot);
}
