// The shell-level preference set one window holds, and the one carrier it reaches.
//
// Three toggles across three pages are the same kind of value — a boolean the SHELL
// owns rather than the daemon or the session: the OS-toast mute
// (`Spec-023 §Console Design (Meridian)` §Notifications, "Mute OS toasts for this
// machine, renderer-local"), automatic updates ("renderer-local preference"), and
// the crash-reporting opt-out ("through the shell-config preference carrier on the
// growth slate … held renderer-side until that carrier lands"). Written per page
// that is three copies of one read, one write, and one degradation, and
// `apps/desktop/AGENTS.md` hoists on the second use.
//
// WHAT THIS MODULE IS, AND WHAT IS NEXT DOOR. This is the STATE MACHINE: the closed
// key set, what each key reads as before anybody chooses, the three answers a
// carrier can give, and the store that folds them. Who owns a store for how long,
// and how React acquires one, is `shell-preferences-holder.ts` — a separate module
// because a store's behaviour and a store's LIFETIME are reviewed against different
// questions, and the file that held both was long enough that neither was legible.
//
// WHY AN UNAVAILABLE CARRIER IS NOT A REJECTED TOGGLE
//
// The carrier is not registered, so every write answers `wire-unregistered` today.
// Snapping the switch back on that answer would tell a person their choice was
// refused, which is false — nobody was asked. So an UNAVAILABLE carrier holds the
// value for this window and the row says so. A carrier that is PRESENT and rejects
// is the other fact, and that one does leave the stored value and render the code
// ("a failed preference write leaves the control at its stored value and renders
// the code"). Both arms are implemented; only the first is reachable today, which
// is why the second is driven by a stub port in this module's own test.
//
// NOTHING HERE PERSISTS, AND THE COPY SAYS SO
//
// `console/persistence/` admits a closed value-class enumeration — layout, scroll,
// selection, pin, expansion, scheme, keybinding — and a preference is none of them.
// Widening that set is a spec amendment rather than a page's decision, so a held
// value lives for this window's lifetime and every consumer renders the note rather
// than implying a durable write nothing performed.

import {
  AttemptGeneration,
  ConsoleRefusalError,
  Emitter,
  isConsoleRefusal,
  refuse,
  type ConsoleRefusal,
  type Unsubscribe,
} from "../../core/index.js";
import type { ConsoleBridge } from "../../bridge/index.js";

/** What one carrier read answers. Derived off the port rather than restated. */
type ShellConfigReadOutcome = Awaited<ReturnType<ConsoleBridge["growth"]["shellConfigRead"]>>;

/**
 * The shell preferences this console has a control for. Closed, and the single
 * declaration: the defaults table below is keyed by the derived union, so a fourth
 * key without a default is a compile error rather than a silently-`false` toggle.
 *
 * The strings are the CONSOLE's names for its own controls, in the growth port's
 * terms — the port's header states its request types are the console's and not a
 * claim about an eventual wire shape — so nothing here composes a method string or
 * a field the corpus registers.
 */
export const SHELL_PREFERENCE_KEYS = [
  "notifications.osToastsMuted",
  "updates.automatic",
  "diagnostics.crashReports",
] as const;

/** One shell preference. Derived from the enumeration, never restated beside it. */
export type ShellPreferenceKey = (typeof SHELL_PREFERENCE_KEYS)[number];

/**
 * What each preference is before anybody has chosen.
 *
 * Automatic updates and crash reporting are ON by default because the corpus makes
 * them so — crash reporting is "enabled by default with PII-stripping; user may opt
 * out via settings" — and the toast mute is OFF because muting by default would
 * silence attention nobody asked to silence.
 */
export const SHELL_PREFERENCE_DEFAULTS: Readonly<Record<ShellPreferenceKey, boolean>> = {
  "notifications.osToastsMuted": false,
  "updates.automatic": true,
  "diagnostics.crashReports": true,
};

/** What the one carrier read answered. Total; every arm renders something. */
export type ShellPreferenceReading =
  | { readonly kind: "not-read" }
  | { readonly kind: "read"; readonly values: Readonly<Record<string, boolean>> }
  | { readonly kind: "unavailable"; readonly refusal: ConsoleRefusal };

/** Everything a toggle row needs, rebuilt on transition and held by identity. */
export interface ShellPreferenceSnapshot {
  readonly reading: ShellPreferenceReading;
  /** Values chosen in this window that no carrier has taken. */
  readonly heldLocally: Readonly<Record<string, boolean>>;
  /** The key whose write is in flight, or `undefined` when none is. */
  readonly pendingKey: ShellPreferenceKey | undefined;
  /** The last refusal per key. Cleared when that key is attempted again. */
  readonly refusalByKey: Readonly<Record<string, ConsoleRefusal>>;
  /** Bumped on every transition, so `useSyncExternalStore` sees a new identity. */
  readonly revision: number;
}

/**
 * What a window reads before its store has been acquired or asked anything.
 *
 * Exported because the React binding next door renders it while its acquiring
 * effect settles: the opening arm a page draws then has to be the SAME snapshot the
 * store itself opens on, and a second literal there would be a second answer to
 * "nothing has happened yet" that nothing keeps equal to this one.
 */
export const NOTHING_CHOSEN: ShellPreferenceSnapshot = {
  reading: { kind: "not-read" },
  heldLocally: {},
  pendingKey: undefined,
  refusalByKey: {},
  revision: 0,
};

/** The subsystem name every refusal this module raises carries. */
export const SHELL_PREFERENCE_REFUSAL_ORIGIN = "shell-preferences";

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
   * The rounds this store's writes have opened.
   *
   * TWO ROLES, ONE GENERATION, which is the shape `core/attempt-generation.ts`
   * describes: a new write supersedes the one before it, so a settled call that is
   * no longer the latest writes nothing — and the OPENING READ is superseded by any
   * write, because the record that read answers with is the record from before the
   * choice. `sessions/durable-view-state.ts` states the same rule for a durable
   * hydration racing a local act; `choose` takes `begin()` and the read takes
   * `current()`, which is what puts the read on the superseded side of it.
   *
   * Being DISPOSED is a separate flag above, because that fact is terminal and this
   * one is not.
   */
  readonly #writes = new AttemptGeneration();

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
   * Idempotent, because React mounts an effect twice under strict mode and a second
   * read would ask the same question twice. One read and no refresh: the wire behind
   * this seam refuses today, so a repeat would re-ask a question with no answer, and
   * `store/scheduling.ts` is where a real re-read lands when there is one.
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
    const write = this.#writes.begin();
    this.#publish({
      ...this.#snapshot,
      pendingKey: key,
      // The prior refusal for THIS key is dropped on the attempt rather than on its
      // settlement, so a person pressing again does not read last time's reason
      // beside this time's spinner.
      refusalByKey: withoutKey(this.#snapshot.refusalByKey, key),
      revision: this.#snapshot.revision + 1,
    });
    try {
      const outcome = await this.#bridge.growth.shellConfigWrite({ key, enabled });
      if (this.#disposed || !this.#writes.isCurrent(write)) {
        return;
      }
      if (outcome.status === "unavailable") {
        // Held, not lost. The carrier was never asked, so the console applies the
        // choice here and the row says where it stops.
        this.#publish({
          ...this.#snapshot,
          heldLocally: { ...this.#snapshot.heldLocally, [key]: enabled },
          pendingKey: undefined,
          revision: this.#snapshot.revision + 1,
        });
        return;
      }
      this.#publish({
        ...this.#snapshot,
        reading: appliedReading(this.#snapshot.reading, key, enabled),
        heldLocally: withoutKey(this.#snapshot.heldLocally, key),
        pendingKey: undefined,
        revision: this.#snapshot.revision + 1,
      });
    } catch (rejection: unknown) {
      if (this.#disposed || !this.#writes.isCurrent(write)) {
        return;
      }
      // A present carrier that rejected. The stored value stands and the code
      // renders beside the control that asked for the change.
      this.#publish({
        ...this.#snapshot,
        pendingKey: undefined,
        refusalByKey: { ...this.#snapshot.refusalByKey, [key]: asRefusal(rejection) },
        revision: this.#snapshot.revision + 1,
      });
    }
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
   * window. That is the trade `sessions/durable-view-state.ts` already makes for the
   * same race, and it is the right one — a stale record installed over an accepted
   * choice is a value nothing on the wire claims, and a default is at least what a
   * key reads as before anybody asks.
   */
  async #read(): Promise<void> {
    const writesAtRead = this.#writes.current();
    let outcome: ShellConfigReadOutcome;
    try {
      outcome = await this.#bridge.growth.shellConfigRead({});
    } catch (rejection: unknown) {
      if (!this.#disposed && this.#writes.isCurrent(writesAtRead)) {
        this.#publish({
          ...this.#snapshot,
          reading: { kind: "unavailable", refusal: asRefusal(rejection) },
          revision: this.#snapshot.revision + 1,
        });
      }
      return;
    }
    if (this.#disposed || !this.#writes.isCurrent(writesAtRead)) {
      return;
    }
    this.#publish({
      ...this.#snapshot,
      reading:
        outcome.status === "served"
          ? { kind: "read", values: outcome.value }
          : { kind: "unavailable", refusal: outcome },
      revision: this.#snapshot.revision + 1,
    });
  }

  #publish(next: ShellPreferenceSnapshot): void {
    this.#snapshot = next;
    this.#changes.emit();
  }
}

/**
 * The value a row shows: this window's choice, then the carrier's, then the default.
 *
 * Exported because the store's own test asserts the precedence directly rather than
 * through a rendered row — the ordering is the rule, and a test that could only see
 * it through a component would be asserting the component instead.
 */
export function effectivePreference(
  snapshot: ShellPreferenceSnapshot,
  key: ShellPreferenceKey,
): boolean {
  const held = snapshot.heldLocally[key];
  if (held !== undefined) {
    return held;
  }
  if (snapshot.reading.kind === "read") {
    const stored = snapshot.reading.values[key];
    if (stored !== undefined) {
      return stored;
    }
  }
  return SHELL_PREFERENCE_DEFAULTS[key];
}

/** The carrier's own record, with one key applied. Never a second copy beside it. */
function appliedReading(
  reading: ShellPreferenceReading,
  key: ShellPreferenceKey,
  enabled: boolean,
): ShellPreferenceReading {
  return reading.kind === "read"
    ? { kind: "read", values: { ...reading.values, [key]: enabled } }
    : { kind: "read", values: { [key]: enabled } };
}

/**
 * Widen any rejection into the console's one refusal shape.
 *
 * A refusal the port already built is passed through verbatim, because rule 9 renders
 * the author's words rather than paraphrasing them; anything else becomes a refusal
 * naming this module with the thrown message as its detail.
 */
function asRefusal(rejection: unknown): ConsoleRefusal {
  if (rejection instanceof ConsoleRefusalError) {
    return rejection.refusal;
  }
  if (isConsoleRefusal(rejection)) {
    return rejection;
  }
  const detail = rejection instanceof Error ? rejection.message : String(rejection);
  return refuse(SHELL_PREFERENCE_REFUSAL_ORIGIN, "preference-write-failed", detail);
}

function withoutKey<TValue>(
  entries: Readonly<Record<string, TValue>>,
  key: string,
): Readonly<Record<string, TValue>> {
  if (!Object.hasOwn(entries, key)) {
    return entries;
  }
  const remaining: Record<string, TValue> = {};
  for (const [heldKey, value] of Object.entries(entries)) {
    if (heldKey !== key) {
      remaining[heldKey] = value;
    }
  }
  return remaining;
}
