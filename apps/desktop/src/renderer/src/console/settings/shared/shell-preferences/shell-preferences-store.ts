// The store that folds one carrier's answers into a shell preference snapshot.
//
// The vocabulary it folds into — the closed key set, the defaults, the three
// readings, and the pure functions over a snapshot — is `shell-preference-snapshot.ts`
// beside it. Who owns a store for how long, and how React acquires one, is
// `shell-preferences-holder.ts`. Three modules because a value's SHAPE, a store's
// BEHAVIOUR, and a store's LIFETIME are reviewed against three different questions.
//
// WHY AN UNAVAILABLE CARRIER IS NOT A REJECTED TOGGLE
//
// The carrier is not registered, so every write answers `wire-unregistered` today.
// Snapping the switch back on that answer would tell a person their choice was
// refused, which is false — nobody was asked. So an UNAVAILABLE carrier holds the
// value for this window and the row says so. A carrier that is PRESENT and rejects
// is the other fact, and that one does leave the stored value and render the code.
// Both arms are implemented; only the first is reachable today, which is why the
// second is driven by a stub port in this module's own test.

import { Emitter, type Unsubscribe } from "../../../core/index.js";
import { GenerationLatch, type GenerationClaim } from "../../../store/index.js";
import type { ConsoleBridge } from "../../../bridge/index.js";
// The console's ONE rejection-to-refusal converter. This module held a second copy
// of it — the same two verbatim arms over a different fallback code — and a second
// copy is what `apps/desktop/AGENTS.md` calls a duplicate refusal constructor. The
// fallback code is still this store's own word, which is all that was ever local
// about it; a carrier that named its own code now KEEPS it, reversing the note this
// replaces, on the console-wide rule that folding a wire code into a generic one
// throws away the one thing a person needs — which refusal it was.
import { consoleRefusalFrom } from "../../../seats/index.js";
import {
  NOTHING_CHOSEN,
  OPENING_READ_KEY,
  PREFERENCE_WRITE_FAILED,
  SHELL_PREFERENCE_REFUSAL_ORIGIN,
  appliedReading,
  withoutKey,
  type ShellConfigReadOutcome,
  type ShellPreferenceKey,
  type ShellPreferenceSnapshot,
} from "./shell-preference-snapshot.js";

/**
 * The shell preference set for one window.
 *
 * A class with private fields rather than a hook body, per `apps/desktop/AGENTS.md`:
 * it owns a read, a write generation, and a teardown. {@link useShellPreferences} is
 * the React binding and holds nothing of its own.
 */
export class ShellPreferenceStore {
  readonly #bridge: ConsoleBridge;
  readonly #changes = new Emitter<void>("shell preference change");
  #snapshot: ShellPreferenceSnapshot = NOTHING_CHOSEN;
  #started = false;
  #disposed = false;
  /**
   * Which acts this store has in flight, keyed by what each one is an act ON.
   *
   * SUPERSESSION BETWEEN WRITES IS PER KEY, because the carrier's write is per key:
   * `shellConfigWrite` takes one key and leaves the others alone, so choosing B while
   * A is in flight replaces nothing of A's. Sharing one round made B's choice discard
   * A's settlement, leaving the carrier holding a value this window went on rendering
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
  readonly #pendingWriteKeys = new Set<ShellPreferenceKey>();

  public constructor(bridge: ConsoleBridge) {
    this.#bridge = bridge;
  }

  public snapshot(): ShellPreferenceSnapshot {
    return this.#snapshot;
  }

  public subscribe(sink: () => void): Unsubscribe {
    return this.#changes.subscribe(sink);
  }

  /**
   * Read the carrier once.
   *
   * Idempotent, because React mounts an effect twice under strict mode. One read and
   * no refresh: the wire behind this seam refuses today, so a repeat would re-ask a
   * question with no answer, and `store/scheduling.ts` is where a real re-read lands.
   */
  public start(): void {
    if (this.#started || this.#disposed) {
      return;
    }
    this.#started = true;
    void this.#read();
  }

  /** Terminal. A reply landing after this writes nothing. */
  public dispose(): void {
    this.#disposed = true;
  }

  /** Whether this store has been superseded. Read by the holder's own test. */
  public get isDisposed(): boolean {
    return this.#disposed;
  }

  /**
   * Choose one preference.
   *
   * The value is offered to the carrier; what happens next is the carrier's answer,
   * and the three arms are kept apart because the next move differs — see the
   * header. Nothing is written twice: a second press while one is in flight
   * supersedes it rather than queueing behind it.
   */
  public async choose(key: ShellPreferenceKey, enabled: boolean): Promise<void> {
    this.#acts.supersede(this, OPENING_READ_KEY);
    const write = this.#acts.supersedeAndClaim(this, key);
    this.#pendingWriteKeys.add(key);
    this.#publish({
      ...this.#snapshot,
      pendingKeys: this.#pendingKeys(),
      // The prior refusal for THIS key is dropped on the attempt rather than on its
      // settlement, so a person pressing again does not read last time's reason
      // beside this time's spinner.
      refusalByKey: withoutKey(this.#snapshot.refusalByKey, key),
      revision: this.#snapshot.revision + 1,
    });
    try {
      const outcome = await this.#bridge.growth.shellConfigWrite({ key, enabled });
      if (!this.#settle(key, write)) {
        return;
      }
      if (outcome.status === "unavailable") {
        // Held, not lost. The carrier was never asked, so the console applies the
        // choice here and the row says where it stops.
        this.#publish({
          ...this.#snapshot,
          heldLocally: { ...this.#snapshot.heldLocally, [key]: enabled },
          pendingKeys: this.#pendingKeys(),
          revision: this.#snapshot.revision + 1,
        });
        return;
      }
      this.#publish({
        ...this.#snapshot,
        reading: appliedReading(this.#snapshot.reading, key, enabled),
        heldLocally: withoutKey(this.#snapshot.heldLocally, key),
        pendingKeys: this.#pendingKeys(),
        revision: this.#snapshot.revision + 1,
      });
    } catch (rejection: unknown) {
      if (!this.#settle(key, write)) {
        return;
      }
      // A present carrier that rejected. The stored value stands and the code
      // renders beside the control that asked for the change.
      this.#publish({
        ...this.#snapshot,
        pendingKeys: this.#pendingKeys(),
        refusalByKey: {
          ...this.#snapshot.refusalByKey,
          [key]: consoleRefusalFrom(
            rejection,
            SHELL_PREFERENCE_REFUSAL_ORIGIN,
            PREFERENCE_WRITE_FAILED,
          ),
        },
        revision: this.#snapshot.revision + 1,
      });
    }
  }

  /** Whether this settled write is still its key's latest, and retire it if it is. */
  #settle(key: ShellPreferenceKey, write: GenerationClaim): boolean {
    if (this.#disposed || !write.isCurrent) {
      return false;
    }
    write.release();
    this.#pendingWriteKeys.delete(key);
    return true;
  }

  /** The keys still in flight, copied so a published snapshot never changes under a reader. */
  #pendingKeys(): ReadonlySet<ShellPreferenceKey> {
    return new Set(this.#pendingWriteKeys);
  }

  /** Drop one key's refusal — the dismiss a person presses on the notice. */
  public dismiss(key: ShellPreferenceKey): void {
    if (!Object.hasOwn(this.#snapshot.refusalByKey, key)) {
      return;
    }
    this.#publish({
      ...this.#snapshot,
      refusalByKey: withoutKey(this.#snapshot.refusalByKey, key),
      revision: this.#snapshot.revision + 1,
    });
  }

  /**
   * The opening read, whose result a later choice DISCARDS rather than installs.
   *
   * The captured round is what makes that checkable. A served write applies the
   * accepted value into the carrier's own record; this read, if it settled
   * afterwards and installed anyway, would replace that whole record with the
   * snapshot from before the choice — so the switch reverted moments after the
   * carrier had taken it, with nothing on screen to say why.
   *
   * Discarding costs the OTHER keys their stored values, because this store reads
   * once and never refreshes: they fall back to their defaults for the rest of the
   * window. That is the trade `sessions/durable-view/durable-view-state.ts` already makes for the
   * same race, and it is the right one — a stale record installed over an accepted
   * choice is a value nothing on the wire claims, and a default is at least what a
   * key reads as before anybody asks.
   */
  async #read(): Promise<void> {
    // A joiner's handle rather than a taken key: this read holds nothing a later act
    // has to wait for, and settling through it ends the round it minted, so the
    // register is empty again the moment the read is done with it.
    const opening = this.#acts.currentClaim(this, OPENING_READ_KEY);
    let outcome: ShellConfigReadOutcome;
    try {
      outcome = await this.#bridge.growth.shellConfigRead({});
    } catch (rejection: unknown) {
      if (this.#disposed) {
        return;
      }
      opening.settle(() => {
        this.#publish({
          ...this.#snapshot,
          reading: {
            kind: "unavailable",
            refusal: consoleRefusalFrom(
              rejection,
              SHELL_PREFERENCE_REFUSAL_ORIGIN,
              PREFERENCE_WRITE_FAILED,
            ),
          },
          revision: this.#snapshot.revision + 1,
        });
      });
      return;
    }
    if (this.#disposed) {
      return;
    }
    opening.settle(() => {
      this.#publish({
        ...this.#snapshot,
        reading:
          outcome.status === "served"
            ? { kind: "read", values: outcome.value }
            : { kind: "unavailable", refusal: outcome },
        revision: this.#snapshot.revision + 1,
      });
    });
  }

  #publish(next: ShellPreferenceSnapshot): void {
    this.#snapshot = next;
    this.#changes.emit();
  }
}
