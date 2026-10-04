// Who holds this window's keybinding overrides and what the frame installs because of them. They
// live in main's keyboard map (one local file, no wire), read once per window and written whole on
// every change through the bridge's `keyboardMap`. `keybinding-overrides.ts` decides what an
// override means and whether it is admissible; this module is the state around it:
//
//   - Consumers read `snapshot.bindings`, never the raw table, so key dispatch and the Keyboard
//     page agree on which keyboard this window has. The snapshot also carries the shipped table
//     so the page can show which rows changed.
//   - `defaults` is a function, not an array, because features contribute chords from effects
//     after construction; a movable base supplies `subscribeToDefaults` and the store re-composes.
//   - An override applies to this window before the write settles, and a refused write is
//     disclosed ("worked for this window, will not come back"), as in
//     `app/hooks/useSchemePreference.ts`.
//   - A stored override passes the same check as a fresh one. A chord that no longer installs is
//     declined and named, since handing it to `setBindings` would raise in the frame's effect; an
//     override for a missing act is skipped and left out of the next write.
//
// `recording` is here although it is not persisted, because it decides what to install. The table
// listens in the capture phase, so it would swallow `$mod+1` before the recorder saw it; the frame
// installs nothing while a chord is being recorded.

import type { KeyboardMap, KeyboardMapReading, Unsubscribe } from "@shared/preload-api.js";
import type { PlatformBridge } from "@renderer/services/platform/platform-bridge.js";
import { Emitter } from "@renderer/lib/emitter.js";
import { refuse, type Refusal } from "@renderer/lib/refusal.js";
import {
  contributedKeybindings,
  subscribeToCommandContributions,
} from "../commands/command-contributions.js";
import { commandRegistry } from "../commands/window-command-registry.js";
import { type Keybinding } from "../commands/command-types.js";
import { GenerationLatch } from "@renderer/lib/reads/generation-latch.js";
import { HOST_CHORD_PLATFORM, type ChordPlatform } from "@renderer/lib/chord-format.js";
import {
  type KeybindingBindResult,
  type KeybindingHydrationRefusal,
  type KeybindingOverrideStoreOptions,
  type KeybindingSnapshot,
} from "./keybinding-override-types.js";
import {
  KEYBINDING_OVERRIDE_REFUSAL_ORIGIN,
  composeEffectiveBindings,
  refuseCandidateChord,
  type KeybindingOverride,
  type KeybindingOverrideRefusal,
} from "./keybinding-overrides.js";

/** The one latch key hydration is taken under; a rebinding supersedes every key. */
const HYDRATION_KEY = "hydrate";

/**
 * The override map, what it composes to, and where it is kept. The cached snapshot is dropped
 * whenever the map or the recording flag moves, and a hydration never overwrites a rebinding or a
 * later hydration that happened while its read was in flight.
 */
export class KeybindingOverrideStore {
  readonly #readDefaults: () => readonly Keybinding[];
  readonly #commandTitle: (commandId: string) => string | undefined;
  readonly #platform: ChordPlatform;
  readonly #changes = new Emitter<void>("keybinding override change");
  #overrides: KeyboardMap = {};
  #keyboardMap: PlatformBridge["keyboardMap"] | undefined;
  #recording = false;
  #snapshot: KeybindingSnapshot | undefined;
  #hydrationRefusals: readonly KeybindingHydrationRefusal[] = [];
  #readRefusal: Refusal | undefined;
  #repair: KeyboardMapReading["repair"];
  /**
   * One generation with two roles, as in `lib/reads/generation-latch.ts`: a rebinding supersedes a
   * hydration in flight (its read holds the map from before the choice), and a second hydration
   * supersedes the first. A superseded settlement is ignored, not stopped.
   */
  readonly #overrideRounds = new GenerationLatch();

  public constructor(options: KeybindingOverrideStoreOptions) {
    this.#readDefaults = options.defaults;
    this.#commandTitle = options.commandTitle;
    this.#platform = options.platform ?? HOST_CHORD_PLATFORM;
    // Never released: the store and the signal are both window-scoped.
    options.subscribeToDefaults?.(() => {
      this.#publish();
    });
  }

  /** Calls `sink` when the effective table or the recording flag moves. */
  public subscribe(sink: () => void): Unsubscribe {
    return this.#changes.subscribe(sink);
  }

  /** What to install and what to draw; one object, stable between changes. */
  public get snapshot(): KeybindingSnapshot {
    const shippedBindings = this.#snapshot === undefined ? this.#readDefaults() : [];
    this.#snapshot ??= {
      bindings: composeEffectiveBindings(shippedBindings, this.#overrides),
      shippedBindings,
      recording: this.#recording,
    };
    return this.#snapshot;
  }

  /** The overrides themselves, for a page that draws which rows changed. */
  public get overrides(): KeyboardMap {
    return this.#overrides;
  }

  /** Stored overrides this window declined to install, with the reason. */
  public get hydrationRefusals(): readonly KeybindingHydrationRefusal[] {
    return this.#hydrationRefusals;
  }

  /** Why the stored map could not be read, while this window runs on the shipped chords. */
  public get readRefusal(): Refusal | undefined {
    return this.#readRefusal;
  }

  /** The repair main made when the stored map was unusable (shipped chords written out again). */
  public get repair(): KeyboardMapReading["repair"] {
    return this.#repair;
  }

  /**
   * Attaches this machine's keyboard map and reads the overrides back. The map is attached before
   * the await so a rebinding made meanwhile is written. Entries for unregistered commands are
   * skipped; each other entry is admitted against the entries admitted before it, so the result
   * is installable. A failed read keeps the shipped chords and sets {@link readRefusal}.
   *
   * Two guards: the round orders the read against a rebinding, and the map identity orders it
   * against a bridge replacement, so a reading installs only into the map it was read from.
   */
  public async hydrateFrom(keyboardMap: PlatformBridge["keyboardMap"]): Promise<void> {
    const round = this.#overrideRounds.supersedeAndClaim(this, HYDRATION_KEY);
    this.#keyboardMap = keyboardMap;
    let reading: KeyboardMapReading;
    try {
      reading = await keyboardMap.read();
    } catch {
      // Main's message can name a local path, which a refusal's detail never carries.
      if (round.isCurrent && this.#keyboardMap === keyboardMap) {
        this.#readRefusal = refuseKeyboardMap(
          "keyboard-map-unread",
          "The keyboard map on this machine could not be read, so this window " +
            "uses the chords the app ships with until it is opened again.",
        );
        this.#publish();
      }
      return;
    }
    if (!round.isCurrent || this.#keyboardMap !== keyboardMap) {
      return;
    }
    const stored = reading.map;
    const admitted: Record<string, KeybindingOverride> = {};
    const refusals: KeybindingHydrationRefusal[] = [];
    for (const commandId of Object.keys(stored).sort()) {
      if (this.#commandTitle(commandId) === undefined) {
        continue;
      }
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
    this.#readRefusal = undefined;
    this.#repair = reading.repair;
    this.#publish();
  }

  /**
   * Puts a chord on a command: refused before anything moves, or applied to this window and then
   * written. The promise settles after the write, when the binding is already live.
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
   * Leaves a command with no chord, and keeps that across reloads; {@link reset} instead restores
   * the shipped chord. Nothing to refuse: an absent chord collides with nothing.
   */
  public async unbind(commandId: string): Promise<KeybindingBindResult> {
    return {
      outcome: "bound",
      chord: null,
      unsaved: await this.#apply(commandId, { ...this.#overrides, [commandId]: null }),
    };
  }

  /** Forgets one override, restoring the shipped chord for that command. */
  public async reset(commandId: string): Promise<Refusal | undefined> {
    const { [commandId]: _dropped, ...remaining } = this.#overrides;
    return await this.#apply(commandId, remaining);
  }

  /** Forgets every override. */
  public async resetAll(): Promise<Refusal | undefined> {
    return await this.#apply(undefined, {});
  }

  /** Suspends the app keyboard while a chord is being recorded. */
  public beginRecording(): void {
    if (!this.#recording) {
      this.#recording = true;
      this.#publish();
    }
  }

  /**
   * Resumes the app keyboard; safe to call twice, since cancel and completion both end here.
   */
  public endRecording(): void {
    if (this.#recording) {
      this.#recording = false;
      this.#publish();
    }
  }

  /**
   * Takes the new map, tells the window, and writes it; answers with the refusal if the write was
   * not kept. `commandId` (or `undefined` for every row) only decides which hydration refusals
   * stay standing.
   */
  async #apply(
    commandId: string | undefined,
    overrides: KeyboardMap,
  ): Promise<Refusal | undefined> {
    this.#overrides = overrides;
    this.#overrideRounds.supersedeAll();
    // The write replaces the repaired file.
    this.#repair = undefined;
    // The row a hydration refusal named was just rewritten, so the refusal is stale.
    this.#hydrationRefusals =
      commandId === undefined
        ? []
        : this.#hydrationRefusals.filter((entry) => entry.commandId !== commandId);
    this.#publish();
    return await this.#persist();
  }

  /**
   * Writes the map and answers with the refusal if main would not keep it. With no map attached it
   * answers `undefined`; the frame attaches before any page that can rebind renders.
   */
  async #persist(): Promise<Refusal | undefined> {
    const keyboardMap = this.#keyboardMap;
    if (keyboardMap === undefined) {
      return undefined;
    }
    try {
      await keyboardMap.write(this.#overrides);
      return undefined;
    } catch {
      return refuseKeyboardMap(
        "keyboard-map-unsaved",
        "The keyboard map on this machine could not be written.",
      );
    }
  }

  #refuse(
    commandId: string,
    chord: string,
    overrides: KeyboardMap,
  ): KeybindingOverrideRefusal | undefined {
    return refuseCandidateChord({
      defaults: this.#readDefaults(),
      overrides,
      commandId,
      chord,
      commandTitle: this.#commandTitle,
      platform: this.#platform,
    });
  }

  #publish(): void {
    this.#snapshot = undefined;
    this.#changes.emit();
  }
}

/**
 * This window's overrides; module scope is window scope because each window is its own renderer
 * process.
 */
export const keybindingOverrides: KeybindingOverrideStore = new KeybindingOverrideStore({
  defaults: contributedKeybindings,
  subscribeToDefaults: subscribeToCommandContributions,
  commandTitle: (commandId) => commandRegistry.get(commandId)?.title,
});

/** Why the keyboard map itself, rather than one chord, was refused. */
type KeyboardMapRefusalCode = "keyboard-map-unread" | "keyboard-map-unsaved";

function refuseKeyboardMap(code: KeyboardMapRefusalCode, detail: string): Refusal {
  return refuse(KEYBINDING_OVERRIDE_REFUSAL_ORIGIN, code, detail);
}
