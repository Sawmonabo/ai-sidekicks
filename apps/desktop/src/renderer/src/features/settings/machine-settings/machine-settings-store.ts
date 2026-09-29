// The store that folds the settings file's answers into a machine settings snapshot.
//
// The vocabulary it folds into is `machine-settings-snapshot.ts`; who owns a store for
// how long, and how React acquires one, is `machine-settings-holder.ts`.

import { Emitter, type Unsubscribe } from "@renderer/lib/emitter.js";
import { GenerationLatch, type GenerationClaim } from "@renderer/lib/reads/generation-latch.js";
import {
  NO_TRIGGERING_EVENT_KINDS,
  type ReadTriggerTarget,
} from "@renderer/store/reads/read-triggers.js";
import { RefreshScheduler, type RefreshReason } from "@renderer/lib/reads/refresh-scheduler.js";
import { type Clock } from "@renderer/lib/clock.js";
import {
  NOTHING_CHOSEN,
  OPENING_READ_KEY,
  appliedReading,
  type MachineSettingKey,
  type MachineSettingsSnapshot,
} from "./machine-settings-snapshot.js";

/**
 * The machine's settings file, as the store reads and writes it.
 */
export interface MachineSettingsFile {
  readonly read: () => Promise<Readonly<Record<string, boolean>>>;
  readonly write: (request: {
    readonly key: MachineSettingKey;
    readonly enabled: boolean;
  }) => Promise<unknown>;
}

/**
 * The machine settings for one window.
 *
 * A class with private fields rather than a hook body, per `apps/desktop/AGENTS.md`:
 * it owns a read, a write generation, and a teardown. {@link useMachineSettings} is
 * the React binding and holds nothing of its own.
 */
export class MachineSettingsStore implements ReadTriggerTarget {
  /** No terminal event refreshes this read; the window triggers are the whole story. */
  public readonly triggeringEventKinds: ReadonlySet<string> = NO_TRIGGERING_EVENT_KINDS;
  readonly #settingsFile: MachineSettingsFile;
  readonly #changes = new Emitter<void>("machine settings change");
  #snapshot: MachineSettingsSnapshot = NOTHING_CHOSEN;
  #started = false;
  #disposed = false;
  /**
   * Which acts this store has in flight, keyed by what each one is an act ON.
   *
   * SUPERSESSION BETWEEN WRITES IS PER KEY, because the settings file's write is per key:
   * The settings file's write takes one key and leaves the others alone, so choosing B while
   * A is in flight replaces nothing of A's. Sharing one round made B's choice discard
   * A's settlement, leaving the settings file holding a value this window went on rendering
   * the old one for — for the rest of the window, since this store reads once and
   * never refreshes. Keying the latch on the preference key states that directly,
   * which is the shape it was built for.
   *
   * The OPENING READ sits on a key of its own and is superseded by any write, because
   * the record that read answers with is the record from before the choice. `choose`
   * supersedes {@link OPENING_READ_KEY} as its first act, so the read's handle goes
   * stale whichever key was chosen.
   *
   * Being DISPOSED is the separate flag above: that fact is terminal and this is not.
   */
  readonly #acts = new GenerationLatch();
  /**
   * The keys a person is waiting on, which is a RENDERED fact and not a second
   * register of the one above: the latch says whether a settlement may install, this
   * says which rows show a spinner while it has not. The latch bounds its own keys
   * and cannot name them, so a surface that renders per row needs the set.
   */
  readonly #pendingWriteKeys = new Set<MachineSettingKey>();
  readonly #scheduler: RefreshScheduler;

  public constructor(clock: Clock, settingsFile: MachineSettingsFile) {
    this.#settingsFile = settingsFile;
    this.#scheduler = new RefreshScheduler({
      clock,
      perform: async () => {
        await this.#read();
      },
    });
  }

  public snapshot(): MachineSettingsSnapshot {
    return this.#snapshot;
  }

  public subscribe(sink: () => void): Unsubscribe {
    return this.#changes.subscribe(sink);
  }

  /**
   * Read the settings file on mount.
   *
   * Idempotent, because React mounts an effect twice under strict mode — and the
   * scheduler behind {@link requestRead} collapses the pair in any case.
   */
  public start(): void {
    if (this.#started) {
      return;
    }
    this.#started = true;
    this.requestRead("subscribe");
  }

  /**
   * Ask for a read.
   *
   * `subscribe` on mount and `window-focus` on return. The settings page is an
   * auxiliary window and the preferences are per USER rather than per window, so a
   * choice made in one window left every other window's copy stale for its whole
   * lifetime — which is the staleness a once-only read has no path out of.
   */
  public requestRead(reason: RefreshReason): void {
    if (this.#disposed) {
      return;
    }
    this.#scheduler.request(reason);
  }

  /** Terminal. A reply landing after this writes nothing. */
  public dispose(): void {
    this.#disposed = true;
    this.#scheduler.dispose();
  }

  /** Whether this store has been superseded. Read by the holder's own test. */
  public get isDisposed(): boolean {
    return this.#disposed;
  }

  /**
   * Choose one preference.
   *
   * The value is offered to the settings file and applied on its answer. A second press while
   * one is in flight supersedes it rather than queueing behind it. A rejected write is
   * not caught; the key stops pending and the stored value stands.
   */
  public async choose(key: MachineSettingKey, enabled: boolean): Promise<void> {
    this.#acts.supersede(this, OPENING_READ_KEY);
    const write = this.#acts.supersedeAndClaim(this, key);
    this.#pendingWriteKeys.add(key);
    this.#publish({
      ...this.#snapshot,
      pendingKeys: this.#pendingKeys(),
      revision: this.#snapshot.revision + 1,
    });
    let isApplied = false;
    try {
      await this.#settingsFile.write({ key, enabled });
      isApplied = true;
    } finally {
      if (this.#settle(key, write)) {
        this.#publish({
          ...this.#snapshot,
          reading: isApplied
            ? appliedReading(this.#snapshot.reading, key, enabled)
            : this.#snapshot.reading,
          pendingKeys: this.#pendingKeys(),
          revision: this.#snapshot.revision + 1,
        });
      }
    }
  }

  /** Whether this settled write is still its key's latest, and retire it if it is. */
  #settle(key: MachineSettingKey, write: GenerationClaim): boolean {
    if (this.#disposed || !write.isCurrent) {
      return false;
    }
    write.release();
    this.#pendingWriteKeys.delete(key);
    return true;
  }

  /** The keys still in flight, copied so a published snapshot never changes under a reader. */
  #pendingKeys(): ReadonlySet<MachineSettingKey> {
    return new Set(this.#pendingWriteKeys);
  }

  /**
   * The opening read, whose result a later choice discards rather than installs.
   *
   * A read that settled after a choice would replace the settings file's whole record with
   * the snapshot from before it, and the switch would revert moments after the settings file
   * took it. Discarding costs the other keys their stored values until the next read.
   */
  async #read(): Promise<void> {
    // A joiner's handle rather than a taken key: this read holds nothing a later act
    // has to wait for, and settling through it ends the round it minted.
    const opening = this.#acts.currentClaim(this, OPENING_READ_KEY);
    const values = await this.#settingsFile.read();
    if (this.#disposed) {
      return;
    }
    opening.settle(() => {
      this.#publish({
        ...this.#snapshot,
        reading: { kind: "read", values },
        revision: this.#snapshot.revision + 1,
      });
    });
  }

  #publish(next: MachineSettingsSnapshot): void {
    this.#snapshot = next;
    this.#changes.emit();
  }
}
