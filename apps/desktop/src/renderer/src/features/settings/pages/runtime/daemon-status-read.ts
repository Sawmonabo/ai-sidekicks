// The Runtime page's reading of the service's own status: its reported line, its version, and
// how much of the machine's processor and memory it is using. It is read when the page opens,
// when what it answers can have moved, and on `Check again`, every time through one refresh
// scheduler, so a burst of asks costs one call and a reply to a superseded read is dropped.
// Nothing samples it on a timer. A settled answer stays on screen while the next read is out.

import type { DaemonStatusReadResponse } from "@ai-sidekicks/contracts/daemon/status";
import type { Unsubscribe } from "#shared/preload-api.js";
import { type Clock } from "#renderer/lib/clock.js";
import { coerceToRefusal } from "#renderer/lib/coerce-to-refusal.js";
import { Emitter } from "#renderer/lib/emitter.js";
import { type ReadRound } from "#renderer/lib/reads/scope.js";
import { RefreshScheduler, type RefreshReason } from "#renderer/lib/reads/refresh/scheduler.js";
import type { Refusal } from "#renderer/lib/refusal/contract.js";
import {
  NO_TRIGGERING_EVENT_KINDS,
  type ReadTriggerTarget,
} from "#renderer/store/reads/triggers.js";

/** The daemon verbs the Runtime page drives. */
export interface DaemonOperations {
  readonly readStatus: () => Promise<DaemonStatusReadResponse>;
  readonly stop: () => Promise<unknown>;
  readonly restart: () => Promise<unknown>;
}

/**
 * What the status reading has to show. `reading` holds until the first read settles; `read`
 * and `failed` are its settlements, the second carrying the refusal the read was answered with.
 */
export type DaemonStatusReading =
  | { readonly phase: "reading" }
  | { readonly phase: "read"; readonly status: DaemonStatusReadResponse }
  | { readonly phase: "failed"; readonly refusal: Refusal };

/** The service's status, read on request through one scheduler. `dispose` is terminal. */
export class DaemonStatusRead implements ReadTriggerTarget {
  /**
   * No session event says the service's own status moved: it is asked again on the page's own
   * signals, never because a run ended.
   */
  public readonly triggeringEventKinds: ReadonlySet<string> = NO_TRIGGERING_EVENT_KINDS;
  readonly #readStatus: DaemonOperations["readStatus"];
  readonly #scheduler: RefreshScheduler;
  readonly #changes = new Emitter<void>("daemon status reading");
  #reading: DaemonStatusReading = { phase: "reading" };
  #isDisposed = false;

  public constructor(readStatus: DaemonOperations["readStatus"], clock: Clock) {
    this.#readStatus = readStatus;
    this.#scheduler = new RefreshScheduler({
      clock,
      perform: async (_reasons, round) => {
        await this.#read(round);
      },
    });
  }

  /** The reading on screen: the last settled answer, or `reading` before the first. */
  public get reading(): DaemonStatusReading {
    return this.#reading;
  }

  /** Whether `dispose` has run. */
  public get isDisposed(): boolean {
    return this.#isDisposed;
  }

  /** Ask for a read; asks inside the scheduler's window collapse into one call. */
  public requestRead(reason: RefreshReason): void {
    this.#scheduler.request(reason);
  }

  /** Hear each settled read. */
  public subscribe(listener: () => void): Unsubscribe {
    return this.#changes.subscribe(listener);
  }

  /** Stop reading and drop the read in flight. Terminal. */
  public dispose(): void {
    this.#isDisposed = true;
    this.#scheduler.dispose();
  }

  async #read(round: ReadRound): Promise<void> {
    let settled: DaemonStatusReading;
    try {
      settled = { phase: "read", status: await this.#readStatus() };
    } catch (error: unknown) {
      settled = { phase: "failed", refusal: coerceToRefusal(error, DAEMON_STATUS_ORIGIN) };
    }
    round.settle(() => {
      this.#reading = settled;
      this.#changes.emit();
    });
  }
}

/** The subsystem a failed status read names as its author. */
const DAEMON_STATUS_ORIGIN = "daemon-status";
