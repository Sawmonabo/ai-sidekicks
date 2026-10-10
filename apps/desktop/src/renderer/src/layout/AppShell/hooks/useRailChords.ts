import { HOST_CHORD_PLATFORM, formatChordForPlatform } from "#renderer/lib/chord-format.js";
import type { RailDestination } from "#renderer/routing/readers.js";
import { SESSIONS_LIST_COMMAND } from "../../NavigationRail/commands.js";

/**
 * The chords the rail's destinations end their names in, printed for the host. Sessions is the
 * one rail button that advertises its chord, the chord of its act, the sessions list, read fresh on
 * every draw so a rebinding changes the hint.
 */
export function useRailChords(
  readBoundChord: (commandId: string) => string | undefined,
): Partial<Record<RailDestination, string>> {
  const chord = readBoundChord(SESSIONS_LIST_COMMAND.commandId);
  return chord === undefined
    ? {}
    : { sessions: formatChordForPlatform(chord, HOST_CHORD_PLATFORM) };
}
