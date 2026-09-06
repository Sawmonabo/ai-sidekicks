// Who holds this window's keybinding overrides, where they are kept, and what the
// frame installs because of them.
//
// `keybinding-overrides.ts` next door decides what an override MEANS and whether one
// is admissible. This module is the state around that model, and three decisions
// carry it:
//
//   • **One accessor, never the raw table.** The frame's key dispatch and the
//     Keyboard page both read `surface.bindings`. A consumer reading the shipped table
//     directly would install, or print, the chords a person replaced — and the two
//     surfaces would then disagree about which keyboard this window has, which is the
//     exact defect a person cannot debug. The page needs the SHIPPED table too, to say
//     which rows were changed, so the snapshot carries that as well rather than sending
//     one reader back to the module the base is declared in.
//   • **The base is READ, not captured.** `defaults` is a function and not an array,
//     because the shipped table is composed from the frame's chords plus whatever the
//     view families have contributed, and a family contributes from an effect — so a
//     table captured once at construction is wrong the moment a family mounts later.
//     A base that can move supplies `subscribeToDefaults` beside the reader, and this
//     store re-composes on that signal like any other change it publishes.
//   • **The override applies to this window before the write settles, and a refused
//     write is disclosed rather than discarded.** `scheme-preference.ts` states the
//     reasoning for the one other window-wide preference: the choice is taken, so the
//     honest sentence is not "that did not work" but "that worked for this window and
//     will not come back".
//   • **A stored override is admitted through the same check a fresh one passes.** A
//     chord that no longer installs is declined and named rather than handed to
//     `setBindings`, which would raise inside the frame's own effect and take the
//     window down over one stale row.
//
// THE CONSOLE KEYBOARD IS SUSPENDED WHILE A CHORD IS BEING RECORDED
//
// `recording` is not a persisted preference and it is here anyway, because it answers
// the same question the frame asks this module every render: what to install right
// now. A recorder capturing presses while the table still listened could not capture
// `$mod+1` at all — the table listens on the window in the CAPTURE phase, so the rail
// would navigate away before any control saw the press. The frame therefore installs
// nothing while a chord is being recorded, and the recorder reads the focused
// control's own press.

import { useCallback, useSyncExternalStore } from "react";

import { Emitter, type ConsoleRefusal, type Unsubscribe } from "../core/index.js";
import type { KeyBinding } from "./contributions.js";
import type { UiStateStore } from "../persistence/index.js";
import { GenerationLatch } from "../store/index.js";
import { HOST_CHORD_PLATFORM, type ChordPlatform } from "../primitives/index.js";
import { consoleKeyBindings, subscribeToConsoleKeyBindings } from "./command-surface.js";
import {
  KEYBINDING_OVERRIDES_KEY,
  type KeybindingBindResult,
  type KeybindingHydrationRefusal,
  type KeybindingOverrideStoreOptions,
  type KeybindingSurface,
} from "./keybinding-surface.js";
import {
  composeEffectiveBindings,
  readOverrideMap,
  refuseCandidateChord,
  type KeybindingOverride,
  type KeybindingOverrideMap,
  type KeybindingOverrideRefusal,
} from "./keybinding-overrides.js";

/**
 * The latch key the hydration round is taken under.
 *
 * One key, because one act is on a round here: a rebinding supersedes every key this
 * store holds rather than a key of its own, so naming a second one would claim a
 * distinction the store does not make.
 */
const HYDRATION_KEY = "hydrate";

/**
 * The override map, what it composes to, and where it is kept.
 *
 * A class because that is state with invariants over it: the cached snapshot is
 * dropped whenever the map or the recording flag moves, and a hydration never
 * overwrites what happened while its read was in flight — a rebinding, or a later
 * hydration of a store that replaced the one it read. Both are only checkable if
 * the state has one owner.
 */
export class KeybindingOverrideStore {
  readonly #readDefaults: () => readonly KeyBinding[];
  readonly #platform: ChordPlatform;
  readonly #changes = new Emitter<void>("keybinding override change");
  #overrides: KeybindingOverrideMap = {};
  #uiStateStore: UiStateStore | undefined;
  #recording = false;
  #snapshot: KeybindingSurface | undefined;
  #hydrationRefusals: readonly KeybindingHydrationRefusal[] = [];
  /**
   * The rounds this store's overrides have moved through.
   *
   * TWO ROLES, ONE GENERATION, which is the shape `store/generation-latch.ts`
   * describes — a monotonic serial, so a superseded settlement is IGNORED rather than
   * claimed to have been stopped — and which
   * `settings/shared/shell-preferences/shell-preferences-store.ts` takes the same way:
   * a rebinding SUPERSEDES a hydration already in flight — the record that read
   * answers with is the map from before the choice, which is the rule
   * `frame/scheme-preference.ts` states for the colour scheme — and a second hydration
   * supersedes the first, because two of them are two answers to one question and
   * only the later one was asked.
   */
  readonly #overrideRounds = new GenerationLatch();

  public constructor(options: KeybindingOverrideStoreOptions) {
    this.#readDefaults = options.defaults;
    this.#platform = options.platform ?? HOST_CHORD_PLATFORM;
    // Never released, and that is the lifetime rather than an omission: this store is
    // window-scoped and the surface it listens to is too, so both die with the window.
    options.subscribeToDefaults?.(() => {
      this.#publish();
    });
  }

  /** Called when the effective table or the recording flag moves. */
  public subscribe(sink: () => void): Unsubscribe {
    return this.#changes.subscribe(sink);
  }

  /** What to install and what to draw. One object, stable between changes. */
  public get surface(): KeybindingSurface {
    const shippedBindings = this.#snapshot === undefined ? this.#readDefaults() : [];
    this.#snapshot ??= {
      bindings: composeEffectiveBindings(shippedBindings, this.#overrides),
      shippedBindings,
      recording: this.#recording,
    };
    return this.#snapshot;
  }

  /** The overrides themselves, for a surface that draws which rows were changed. */
  public get overrides(): KeybindingOverrideMap {
    return this.#overrides;
  }

  /** Stored overrides this window declined to install, with the service's reason. */
  public get hydrationRefusals(): readonly KeybindingHydrationRefusal[] {
    return this.#hydrationRefusals;
  }

  /**
   * Attach this window's durable store and read the overrides back.
   *
   * The store is attached BEFORE the await, so a rebinding made a millisecond later
   * is persisted rather than dropped for want of somewhere to put it. Each stored
   * entry is then admitted against the table built from the entries admitted before
   * it, so the composed result is installable by construction.
   *
   * TWO GUARDS, AND NEITHER IS THE OTHER'S SPARE. The round orders this read against
   * a REBINDING, which replaces no store; the identity orders it against a STORE
   * REPLACEMENT — the frame swapping the durable store under a window on a bridge or
   * scenario change — and states the invariant the record has to satisfy directly:
   * it is installed only into the store it was read from, and only while that store
   * is the one this window will persist the next rebinding into. Resting the second
   * fact on the first would work today, because this method is the only writer of
   * the field, and would go quiet the day anything else attaches a store.
   */
  public async hydrateFrom(uiStateStore: UiStateStore): Promise<void> {
    const round = this.#overrideRounds.supersedeAndClaim(this, HYDRATION_KEY);
    this.#uiStateStore = uiStateStore;
    const record = await uiStateStore.readGlobal(KEYBINDING_OVERRIDES_KEY);
    if (!round.isCurrent || this.#uiStateStore !== uiStateStore) {
      return;
    }
    const stored = readOverrideMap(record?.value);
    const admitted: Record<string, KeybindingOverride> = {};
    const refusals: KeybindingHydrationRefusal[] = [];
    for (const commandId of Object.keys(stored).sort()) {
      const override = stored[commandId];
      if (override === undefined || override === null) {
        admitted[commandId] = null;
        continue;
      }
      const refusal = this.#refuse(commandId, override, admitted);
      if (refusal === undefined) {
        admitted[commandId] = override;
      } else {
        refusals.push({ commandId, chord: override, refusal });
      }
    }
    this.#overrides = admitted;
    this.#hydrationRefusals = refusals;
    this.#publish();
  }

  /**
   * Put a chord on a command.
   *
   * Refused before anything moves, or applied to this window and then written. The
   * returned promise settles once the write has, so a caller can disclose a refused
   * one; the binding is already live by then.
   */
  public async bind(commandId: string, chord: string): Promise<KeybindingBindResult> {
    const refusal = this.#refuse(commandId, chord, this.#overrides);
    if (refusal !== undefined) {
      return { outcome: "refused", refusal };
    }
    return {
      outcome: "bound",
      chord,
      unsaved: await this.#apply(commandId, { ...this.#overrides, [commandId]: chord }),
    };
  }

  /**
   * Leave a command with no chord, and mean it.
   *
   * Distinct from {@link reset}: this is a person saying the command should have no
   * chord, which survives a reload; a reset says they never had an opinion, which
   * restores the shipped one. Nothing to refuse — an absent chord collides with
   * nothing and no host reserves it.
   */
  public async unbind(commandId: string): Promise<KeybindingBindResult> {
    return {
      outcome: "bound",
      chord: null,
      unsaved: await this.#apply(commandId, { ...this.#overrides, [commandId]: null }),
    };
  }

  /** Forget one override, restoring whatever the console ships for that command. */
  public async reset(commandId: string): Promise<ConsoleRefusal | undefined> {
    const { [commandId]: _dropped, ...remaining } = this.#overrides;
    return await this.#apply(commandId, remaining);
  }

  /** Forget every override. The keyboard is the one the console ships. */
  public async resetAll(): Promise<ConsoleRefusal | undefined> {
    return await this.#apply(undefined, {});
  }

  /**
   * Suspend the console keyboard while a chord is being recorded.
   *
   * A pair rather than a setter, so a call site reads as what it does. `endRecording`
   * is safe twice: a cancelled recorder and a completed one both end here.
   */
  public beginRecording(): void {
    if (!this.#recording) {
      this.#recording = true;
      this.#publish();
    }
  }

  public endRecording(): void {
    if (this.#recording) {
      this.#recording = false;
      this.#publish();
    }
  }

  /**
   * Take the new map, tell the window, and write it. Answers with the refusal if the
   * store would not keep it, which is the only thing any caller learns from here —
   * an override the caller chose is already applied by the time this returns.
   *
   * `commandId` is the row the act was about, or `undefined` for a reset of every
   * row. It decides nothing except which hydration refusals are still standing.
   */
  async #apply(
    commandId: string | undefined,
    overrides: KeybindingOverrideMap,
  ): Promise<ConsoleRefusal | undefined> {
    this.#overrides = overrides;
    this.#overrideRounds.supersedeAll();
    // A hydration refusal names a row this window declined. The row it named has
    // just been rewritten by hand, so the refusal is stale rather than answered.
    this.#hydrationRefusals =
      commandId === undefined
        ? []
        : this.#hydrationRefusals.filter((entry) => entry.commandId !== commandId);
    this.#publish();
    return await this.#persist();
  }

  /**
   * Write the map, and answer with the refusal if the store would not keep it.
   *
   * A window with no store attached answers `undefined` rather than a refusal it
   * cannot name: the frame attaches before it renders a surface that can rebind, so
   * the only callers reaching that arm drive the model directly.
   */
  async #persist(): Promise<ConsoleRefusal | undefined> {
    const uiStateStore = this.#uiStateStore;
    if (uiStateStore === undefined) {
      return undefined;
    }
    const result = await uiStateStore.writeGlobal(
      KEYBINDING_OVERRIDES_KEY,
      "keybinding",
      this.#overrides,
    );
    return result.outcome === "refused" ? result.refusal : undefined;
  }

  #refuse(
    commandId: string,
    chord: string,
    overrides: KeybindingOverrideMap,
  ): KeybindingOverrideRefusal | undefined {
    return refuseCandidateChord({
      defaults: this.#readDefaults(),
      overrides,
      commandId,
      chord,
      platform: this.#platform,
    });
  }

  #publish(): void {
    this.#snapshot = undefined;
    this.#changes.emit();
  }
}

/**
 * This window's overrides.
 *
 * Module scope IS window scope here, for the reason `command-surface.ts` gives about
 * the registry it holds the same way: an auxiliary window is its own renderer
 * process, so no channel joins two windows' module graphs — and the settings page
 * reaches the seam the frame installs from without a store threaded through a page
 * contract that deliberately carries none.
 */
export const consoleKeybindingOverrides: KeybindingOverrideStore = new KeybindingOverrideStore({
  defaults: consoleKeyBindings,
  subscribeToDefaults: subscribeToConsoleKeyBindings,
});

/**
 * Read the seam from a component, re-rendering when an override is written.
 *
 * `useSyncExternalStore` rather than an effect writing into state: an override
 * written between a render and its subscription is missed by the effect shape, and a
 * keyboard silently disagreeing with the page describing it is the failure this seam
 * exists to prevent.
 */
export function useKeybindingSurface(store: KeybindingOverrideStore): KeybindingSurface {
  const subscribe = useCallback(
    (onStoreChange: () => void) => store.subscribe(onStoreChange),
    [store],
  );
  const read = useCallback(() => store.surface, [store]);
  return useSyncExternalStore(subscribe, read, read);
}
