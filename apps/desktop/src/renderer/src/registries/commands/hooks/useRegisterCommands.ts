// Contributes commands for as long as a component is mounted, and binds no chords.
//
// It goes through the contribution registry rather than `registerCommands`: the palette
// re-reads only when a contribution signal moves its revision, so direct registration
// would stay invisible to an open palette. Which of several mounts owns the rows is the
// registry's bookkeeping; the hook returns the registry's release as its cleanup.
// A chord is a window-wide claim that panes would race for, so the palette is the keyboard path.

import { useEffect } from "react";

import { commandContributionRegistry } from "../contributions.js";
import type { CommandDefinition } from "../types.js";

/** No chords, always; frozen so a caller cannot add one. */
const NO_KEY_BINDINGS: readonly [] = Object.freeze([]);

/**
 * Contributes `commands` under `owner` while the component is mounted. `commands` must be
 * referentially stable while its contents are unchanged: a new identity re-registers the rows
 * and bumps the palette revision.
 */
export function useRegisterCommands(owner: string, commands: readonly CommandDefinition[]): void {
  useEffect(
    // The release withdraws this contribution alone; see `CommandContributionRelease`.
    () => commandContributionRegistry.contribute({ owner, commands, keyBindings: NO_KEY_BINDINGS }),
    [owner, commands],
  );
}
