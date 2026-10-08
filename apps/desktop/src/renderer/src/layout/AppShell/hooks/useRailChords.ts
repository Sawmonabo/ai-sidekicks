import { HOST_CHORD_PLATFORM, formatChordForPlatform } from "#renderer/lib/chord-format.js";
import type { RailDestination } from "#renderer/routing/readers.js";
import { RAIL_NAVIGATION_DETAILS } from "../../NavigationRail/commands.js";

/**
 * The chords the rail's destinations end their names in, printed for the host. Sessions is the
 * one rail button that advertises its chord, read fresh on every draw so a rebinding changes the
 * hint.
 */
export function useRailChords(
  readBoundChord: (commandId: string) => string | undefined,
): Partial<Record<RailDestination, string>> {
  const chord = readBoundChord(RAIL_NAVIGATION_DETAILS.sessions.commandId);
  return chord === undefined
    ? {}
    : { sessions: formatChordForPlatform(chord, HOST_CHORD_PLATFORM) };
}
