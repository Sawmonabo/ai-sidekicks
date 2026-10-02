// The vocabulary the override store speaks in: what a rebinding answered, what a declined stored
// override looks like, what the frame installs and the Keyboard page draws, and what the store is
// built over. The state itself is in `keybinding-override-store.ts`; the map is main's, reached
// through the bridge's `keyboardMap`.

import type { Refusal } from "@renderer/lib/refusal.js";
import type { Unsubscribe } from "@renderer/lib/emitter.js";
import type { ChordPlatform } from "@renderer/lib/chord-format.js";
import type { Keybinding } from "../commands/command-types.js";
import type { KeybindingOverride, KeybindingOverrideRefusal } from "./keybinding-overrides.js";

/**
 * What a rebinding did. `unsaved` sits on the accepted arm: the chord is bound in this window
 * either way, and a refused write only costs a reload.
 */
export type KeybindingBindResult =
  | {
      readonly outcome: "bound";
      readonly chord: KeybindingOverride;
      readonly unsaved: Refusal | undefined;
    }
  | { readonly outcome: "refused"; readonly refusal: KeybindingOverrideRefusal };

/** A stored override this window declined to install, with the reason. */
export interface KeybindingHydrationRefusal {
  readonly commandId: string;
  readonly chord: string;
  readonly refusal: KeybindingOverrideRefusal;
}

/**
 * What the frame installs and the Keyboard page draws, as one value. It is one object because
 * `useSyncExternalStore` compares by identity, and two accessors would re-render twice per act.
 */
export interface KeybindingSnapshot {
  /** The effective table: the shipped chords with this window's overrides applied. */
  readonly bindings: readonly Keybinding[];
  /**
   * The shipped table the overrides were composed onto, as read. A page asking which rows a
   * person changed needs the table the changes are not in.
   */
  readonly shippedBindings: readonly Keybinding[];
  /** True while a chord is being recorded, which suspends the app keyboard. */
  readonly recording: boolean;
}

/** What the override store is built over. */
export interface KeybindingOverrideStoreOptions {
  /**
   * Reads the chords the app ships and composes overrides onto them. It is a reader, not an
   * array, so chords contributed after construction are included.
   */
  readonly defaults: () => readonly Keybinding[];
  /**
   * Signals that the shipped table moved; absent means it never does. The store re-composes and
   * publishes on the signal, as it does for a rebinding.
   */
  readonly subscribeToDefaults?: (onDefaultsChange: () => void) => Unsubscribe;
  /**
   * The on-screen title of the act a command id names, or `undefined` for an act this window
   * lacks. A stored override for a missing act is skipped silently and dropped from the next write.
   */
  readonly commandTitle: (commandId: string) => string | undefined;
  /** Whose reserved chords to refuse; defaults to the host being run on. */
  readonly platform?: ChordPlatform;
}
