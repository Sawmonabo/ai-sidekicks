// The store that folds the service's answers about the machine's settings file into a
// snapshot; `machine-settings-holder.ts` owns its lifetime.

import type {
  MachineSettings,
  MachineSettingsChange,
  MachineSettingsReading,
} from "@ai-sidekicks/contracts/machine-settings";
import type { Unsubscribe } from "@shared/preload-api.js";
import { coerceToRefusal } from "@renderer/lib/coerce-to-refusal.js";
import { Emitter } from "@renderer/lib/emitter.js";
import type { Refusal } from "@renderer/lib/refusal/refusal.js";
import type { PlatformBridge } from "@renderer/services/platform/platform-bridge.js";
import { openReopeningSubscription } from "@renderer/services/transport/reopening-subscription.js";
import type { TransportReconnectSignal } from "@renderer/services/transport/transport-reconnect.js";
import { GenerationLatch } from "@renderer/lib/reads/generation-latch.js";
import {
  NOTHING_CHOSEN,
  type MachineSettingsMember,
  type MachineSettingsSnapshot,
} from "./machine-settings-snapshot.js";

/**
 * The latch key a write's answer is installed under.
 *
 * One key for every member: every answer is the whole file, so an older answer landing after
 * a newer write's answer or a feed delivery is stale whichever member it was about.
 */
const ANSWER_KEY = "answer";

/** The subsystem a refused settings write names as its author. */
const MACHINE_SETTINGS_WRITE_ORIGIN = "machine-settings-write";

/** The code a rejected write that carried none of its own is reported under. */
const MACHINE_SETTINGS_WRITE_FAILED = "machine-settings-write-failed";

/** The feed's name in the diagnostic records of its ends. */
const MACHINE_SETTINGS_FEED_SUBJECT = "daemon.machineSettingsSubscribe";

/** What the store asks of the bridge's `machineSettings`: the write and the feed. */
export type MachineSettingsService = Pick<PlatformBridge["machineSettings"], "write" | "subscribe">;

/**
 * The machine settings for one window.
 *
 * The feed is the read: the bridge's subscription delivers the file as it stands and then
 * each written change, so a delivery always installs and no separate read is made. A feed that
 * could not open, or ended before delivering, opens again when the transport comes back; one that
 * ended after delivering opens again at once, and its first delivery is the file as it stands, so
 * nothing written meanwhile is missed.
 */
export class MachineSettingsStore {
  readonly #machineSettings: MachineSettingsService;
  readonly #transportReconnect: TransportReconnectSignal;
  readonly #changes = new Emitter<void>("machine settings change");
  #snapshot: MachineSettingsSnapshot = NOTHING_CHOSEN;
  #unsubscribe: Unsubscribe | undefined;
  #disposed = false;
  /**
   * Whether a write's answer may still install; a later write or a feed delivery supersedes
   * it. Separate from the terminal disposed flag.
   */
  readonly #answers = new GenerationLatch();
  /** Writes in flight per member; a count, so one of two settling does not clear the row. */
  readonly #writesInFlight = new Map<MachineSettingsMember, number>();

  public constructor(
    machineSettings: MachineSettingsService,
    transportReconnect: TransportReconnectSignal,
  ) {
    this.#machineSettings = machineSettings;
    this.#transportReconnect = transportReconnect;
  }

  public snapshot(): MachineSettingsSnapshot {
    return this.#snapshot;
  }

  public subscribe(sink: () => void): Unsubscribe {
    return this.#changes.subscribe(sink);
  }

  /** Subscribe to the service's feed. Idempotent, because strict mode mounts an effect twice. */
  public start(): void {
    if (this.#unsubscribe !== undefined || this.#disposed) {
      return;
    }
    // The feed's first delivery is the file as it stands, so a re-open needs no read of its own.
    this.#unsubscribe = openReopeningSubscription({
      signal: this.#transportReconnect,
      subject: MACHINE_SETTINGS_FEED_SUBJECT,
      open: (deliver, onEnded) => this.#machineSettings.subscribe(deliver, onEnded),
      onFrame: (reading: MachineSettingsReading) => {
        this.#install(reading);
      },
      firstOpenFailure: "reopenOnReconnect",
    });
  }

  /** Terminal. A reply landing after this writes nothing. */
  public dispose(): void {
    this.#disposed = true;
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
  }

  /**
   * Choose one member's value.
   *
   * The service's answer (the file as written) is installed unless newer news arrived first.
   * A rejected write records the service's refusal against the member, which stops pending
   * and keeps the stored value.
   */
  public async choose<Member extends MachineSettingsMember>(
    member: Member,
    value: MachineSettings[Member],
  ): Promise<void> {
    const answer = this.#answers.supersedeAndClaim(this, ANSWER_KEY);
    this.#writesInFlight.set(member, (this.#writesInFlight.get(member) ?? 0) + 1);
    this.#publish({
      ...this.#snapshot,
      pendingMembers: this.#pendingMembers(),
      refusalByMember: this.#refusalsWith(member, undefined),
    });
    const change: MachineSettingsChange = { [member]: value };
    let written: MachineSettings | undefined;
    let refusal: Refusal | undefined;
    try {
      written = await this.#machineSettings.write(change);
    } catch (error) {
      refusal = coerceToRefusal(
        error,
        MACHINE_SETTINGS_WRITE_ORIGIN,
        MACHINE_SETTINGS_WRITE_FAILED,
      );
    }
    this.#settleWrite(member);
    if (this.#disposed) {
      return;
    }
    const reading =
      written !== undefined && answer.isCurrent ? { settings: written } : this.#snapshot.reading;
    answer.release();
    this.#publish({
      ...this.#snapshot,
      reading,
      pendingMembers: this.#pendingMembers(),
      refusalByMember: this.#refusalsWith(member, refusal),
    });
  }

  #install(reading: MachineSettingsReading): void {
    if (this.#disposed) {
      return;
    }
    this.#answers.supersede(this, ANSWER_KEY);
    this.#publish({ ...this.#snapshot, reading });
  }

  #settleWrite(member: MachineSettingsMember): void {
    const remaining = (this.#writesInFlight.get(member) ?? 1) - 1;
    if (remaining === 0) {
      this.#writesInFlight.delete(member);
    } else {
      this.#writesInFlight.set(member, remaining);
    }
  }

  /** The refusals with `member`'s replaced, or dropped where `refusal` is `undefined`. */
  #refusalsWith(
    member: MachineSettingsMember,
    refusal: Refusal | undefined,
  ): ReadonlyMap<MachineSettingsMember, Refusal> {
    const refusals = new Map(this.#snapshot.refusalByMember);
    if (refusal === undefined) {
      refusals.delete(member);
    } else {
      refusals.set(member, refusal);
    }
    return refusals;
  }

  /** The members still in flight, copied so a published snapshot never changes under a reader. */
  #pendingMembers(): ReadonlySet<MachineSettingsMember> {
    return new Set(this.#writesInFlight.keys());
  }

  #publish(next: MachineSettingsSnapshot): void {
    this.#snapshot = next;
    this.#changes.emit();
  }
}
