// What the override store answers in, and where its record is kept.
//
// The shapes and the state machine over them fail differently, and they are read by
// different callers. `keybinding-override-store.ts` beside this file owns the state —
// what supersedes what, when a snapshot is dropped, which write settles — while what
// is here is the vocabulary that state is expressed in: what a rebinding answered,
// what a stored override this window declined looks like, what the frame installs and
// the Keyboard page draws, and what the store is built over.
//
// The record key is declared here rather than beside `SCHEME_PREFERENCE_KEY` because
// this record has exactly one addresser — the store next door — and every other reader
// goes through it. The scheme's key is shared because a second reader, the end-to-end
// tier opening its own connection, addresses that record directly.

import type { ConsoleRefusal, Unsubscribe } from "../core/index.js";
import type { ChordPlatform } from "../primitives/index.js";
import type { KeyBinding } from "./contributions.js";
import type { KeybindingOverride, KeybindingOverrideRefusal } from "./keybinding-overrides.js";

/** The key the override map occupies inside the window-wide partition. */
export const KEYBINDING_OVERRIDES_KEY = "keybindings";

/**
 * What a rebinding did.
 *
 * `unsaved` sits on the accepted arm rather than turning it into a failure: the chord
 * IS bound in this window either way, and what a refused write costs is a reload,
 * which is a different sentence from "the chord was not taken".
 */
export type KeybindingBindResult =
  | {
      readonly outcome: "bound";
      readonly chord: KeybindingOverride;
      readonly unsaved: ConsoleRefusal | undefined;
    }
  | { readonly outcome: "refused"; readonly refusal: KeybindingOverrideRefusal };

/** A stored override this window declined to install, with the service's reason. */
export interface KeybindingHydrationRefusal {
  readonly commandId: string;
  readonly chord: string;
  readonly refusal: KeybindingOverrideRefusal;
}

/**
 * What the frame installs and what the Keyboard page draws, as one value.
 *
 * One snapshot object rather than two accessors, because `useSyncExternalStore`
 * compares by identity: two readings of two fields would be two subscriptions to one
 * change, and a caller needing both would re-render twice per act.
 */
export interface KeybindingSurface {
  /** The effective table: the shipped chords with this window's overrides applied. */
  readonly bindings: readonly KeyBinding[];
  /**
   * The shipped table these overrides were composed ONTO, as it was read.
   *
   * Beside the effective one rather than instead of it, because the two answer
   * different questions and a surface asking "which rows did this person change" needs
   * the one the changes are not in. Reading it off this snapshot is what keeps that
   * answer in step with the table the frame is installing — where a page reading the
   * base's own module would be a second reading the moment the base stops being one
   * module's constant. The Keyboard page still reads that constant, because today it
   * IS the whole base; the day the base is composed, that page reads this member and
   * nothing else about it changes.
   */
  readonly shippedBindings: readonly KeyBinding[];
  /** True while a chord is being recorded, which suspends the console keyboard. */
  readonly recording: boolean;
}

export interface KeybindingOverrideStoreOptions {
  /**
   * Reads the chords the console ships. Overrides are composed onto what it answers.
   *
   * A reader rather than the table, so a base that grows as families contribute is
   * read at composition time instead of captured at construction.
   */
  readonly defaults: () => readonly KeyBinding[];
  /**
   * Signals that the shipped table has moved, where it can. Absent means it cannot.
   *
   * The store re-composes and publishes on the signal, so every reader of the surface
   * re-renders exactly as it does for a rebinding. A base that never moves supplies
   * nothing, and the reader above is then called once per composition and no oftener.
   */
  readonly subscribeToDefaults?: (onDefaultsChange: () => void) => Unsubscribe;
  /** Which host's reserved chords to refuse. Defaults to the one being run on. */
  readonly platform?: ChordPlatform;
}
