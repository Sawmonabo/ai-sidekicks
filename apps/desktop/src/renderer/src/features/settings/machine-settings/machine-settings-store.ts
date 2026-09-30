// The store that folds the service's answers about the machine's settings file into a
// snapshot.
//
// The vocabulary it folds into is `machine-settings-snapshot.ts`; who owns a store for
// how long, and how React acquires one, is `machine-settings-holder.ts`.

import type { MachineSettings, MachineSettingsChange } from "@ai-sidekicks/contracts";
import type { PreloadApi, Unsubscribe } from "@shared/preload-api.js";
import { Emitter } from "@renderer/lib/emitter.js";
import { GenerationLatch } from "@renderer/lib/reads/generation-latch.js";
import {
  NOTHING_CHOSEN,
  type MachineSettingsMember,
  type MachineSettingsSnapshot,
} from "./machine-settings-snapshot.js";

/**
 * The latch key a write's answer is installed under.
 *
 * One key for every member, because every answer is the WHOLE file: a newer write's
 * answer or a feed delivery already carries what an older write's answer would install,
 * so an older answer landing after either is stale whichever member it was about.
 */
const ANSWER_KEY = "answer";

/**
 * The machine settings for one window.
 *
 * A class with private fields rather than a hook body, per `apps/desktop/AGENTS.md`: it
 * owns a subscription, a write generation, and a teardown. `useMachineSettings` is the
 * React binding and holds nothing of its own.
 *
 * THE FEED IS THE READ. The bridge's subscription delivers the file as it stands first
 * and then each written change, from this window or any other, so the store asks for no
 * separate read and refreshes on nothing: a delivery always installs, because it is the
 * newest thing the service has said.
 */
export class MachineSettingsStore {
  readonly #machineSettings: PreloadApi["machineSettings"];
  readonly #changes = new Emitter<void>("machine settings change");
  #snapshot: MachineSettingsSnapshot = NOTHING_CHOSEN;
  #unsubscribe: Unsubscribe | undefined;
  #disposed = false;
  /**
   * Whether a write's answer may still install. A write takes the key, and a later
   * write or a feed delivery supersedes it, so an answer that lands after newer news is
   * dropped rather than put over it. Being DISPOSED is the separate flag above: that
   * fact is terminal and this is not.
   */
  readonly #answers = new GenerationLatch();
  /**
   * How many writes are in flight per member: the rows a person is waiting on. A count
   * rather than a flag, so the first of two writes for one member settling does not
   * stop the row saying the second is still on its way.
   */
  readonly #writesInFlight = new Map<MachineSettingsMember, number>();

  public constructor(machineSettings: PreloadApi["machineSettings"]) {
    this.#machineSettings = machineSettings;
  }

  public snapshot(): MachineSettingsSnapshot {
    return this.#snapshot;
  }

  public subscribe(sink: () => void): Unsubscribe {
    return this.#changes.subscribe(sink);
  }

  /**
   * Subscribe to the service's feed.
   *
   * Idempotent, because React mounts an effect twice under strict mode.
   */
  public start(): void {
    if (this.#unsubscribe !== undefined || this.#disposed) {
      return;
    }
    this.#unsubscribe = this.#machineSettings.subscribe((reading) => {
      if (this.#disposed) {
        return;
      }
      this.#answers.supersede(this, ANSWER_KEY);
      this.#publish({ ...this.#snapshot, reading, revision: this.#snapshot.revision + 1 });
    });
  }

  /** Terminal. A reply landing after this writes nothing. */
  public dispose(): void {
    this.#disposed = true;
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
  }

  /** Whether this store has been superseded. Read by the holder's own test. */
  public get isDisposed(): boolean {
    return this.#disposed;
  }

  /**
   * Choose one member's value.
   *
   * The change is offered to the service and its answer, the file as written, is
   * installed unless newer news arrived first. A written change carries no repair, so
   * the answer clears one. A rejected write is not caught; the member stops pending and
   * the stored value stands.
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
      revision: this.#snapshot.revision + 1,
    });
    const change: MachineSettingsChange = { [member]: value };
    let written: MachineSettings | undefined;
    try {
      written = await this.#machineSettings.write(change);
    } finally {
      this.#settleWrite(member);
      if (!this.#disposed) {
        const reading =
          written !== undefined && answer.isCurrent
            ? { settings: written }
            : this.#snapshot.reading;
        answer.release();
        this.#publish({
          ...this.#snapshot,
          reading,
          pendingMembers: this.#pendingMembers(),
          revision: this.#snapshot.revision + 1,
        });
      }
    }
  }

  #settleWrite(member: MachineSettingsMember): void {
    const remaining = (this.#writesInFlight.get(member) ?? 1) - 1;
    if (remaining === 0) {
      this.#writesInFlight.delete(member);
    } else {
      this.#writesInFlight.set(member, remaining);
    }
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
