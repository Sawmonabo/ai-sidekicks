// What a rebinding is: the override a person authored, the table it composes to, and whether one
// is admissible. The shipped chords are `contributedKeybindings` in
// `registries/commands/contributions.ts`.
//
// The effective table is composed from the shipped table and the override map by a pure function,
// never edited in place. A candidate chord is refused before anything is stored, by composing it
// into the whole table and asking `keybinding-audit.ts`, so chord meaning and collision rules are
// not re-decided here. Everything here is pure; the state is in `keybinding-override-store.ts`.

import type { KeyboardMap } from "#shared/preload-api.js";
import { refuse, type Refusal } from "#renderer/lib/refusal/refusal.js";
import type { Keybinding } from "../commands/types.js";
import {
  formatChordForPlatform,
  HOST_CHORD_PLATFORM,
  type ChordPlatform,
} from "#renderer/lib/chord-format.js";
import { auditKeybindings, reservedChordReason } from "./keybinding-audit.js";

/**
 * What a person put on one command: a chord, or `null` for explicitly unbound. An absent entry
 * means untouched, which keeps the shipped chord and is what a reset restores.
 */
export type KeybindingOverride = KeyboardMap[string];

/** Why a candidate chord was refused. Rendered verbatim; never swallowed. */
export const KEYBINDING_OVERRIDE_REFUSAL_CODES = [
  "chord-reserved",
  "chord-unbindable",
  "chord-taken",
] as const;

/** One refusal code. */
export type KeybindingOverrideRefusalCode = (typeof KEYBINDING_OVERRIDE_REFUSAL_CODES)[number];

/** The subsystem name every refusal this module raises carries. */
export const KEYBINDING_OVERRIDE_REFUSAL_ORIGIN = "keybinding-overrides";

/** The app's refusal shape narrowed to this module's codes, so it renders like any refusal. */
export interface KeybindingOverrideRefusal extends Refusal {
  readonly code: KeybindingOverrideRefusalCode;
}

/** What deciding a candidate chord needs beyond the chord and the command. */
export interface CandidateChordInput {
  /** The chords the app ships; overrides are composed onto this table. */
  readonly defaults: readonly Keybinding[];
  /** The overrides already held; the candidate is judged against them. */
  readonly overrides: KeyboardMap;
  readonly commandId: string;
  readonly chord: string;
  /** The act's on-screen title for a command id, or `undefined` for an act this window lacks. */
  readonly commandTitle: (commandId: string) => string | undefined;
  /** Whose reserved chords to refuse; defaults to the host being run on. */
  readonly platform?: ChordPlatform;
}

/**
 * Applies an override map to a binding table: an absent entry keeps the shipped binding, `null`
 * drops it, a chord replaces it. An override for an unbound command appends a binding, ordered by
 * command id so two windows with the same overrides install the same table.
 */
export function composeEffectiveBindings(
  defaults: readonly Keybinding[],
  overrides: KeyboardMap,
): readonly Keybinding[] {
  const effective: Keybinding[] = [];
  const boundByDefault = new Set<string>();
  for (const binding of defaults) {
    boundByDefault.add(binding.commandId);
    const override = overrides[binding.commandId];
    if (override === undefined) {
      effective.push(binding);
    } else if (override !== null) {
      effective.push({ ...binding, chord: override });
    }
  }
  for (const commandId of Object.keys(overrides).sort()) {
    const override = overrides[commandId];
    if (typeof override === "string" && !boundByDefault.has(commandId)) {
      effective.push({ chord: override, commandId });
    }
  }
  return effective;
}

/**
 * Returns why this chord cannot install on this command given these overrides, or `undefined`.
 * Reserved chords are checked first, since a chord the host eats parses fine but never fires; the
 * other verdicts come from the whole candidate table, because a chord is free only relative to it.
 */
export function refuseCandidateChord(
  input: CandidateChordInput,
): KeybindingOverrideRefusal | undefined {
  const { defaults, overrides, commandId, chord } = input;
  const platform = input.platform ?? HOST_CHORD_PLATFORM;
  const reserved = reservedChordReason(chord, platform);
  if (reserved !== undefined) {
    return refuseOverride("chord-reserved", reserved);
  }
  const audit = auditKeybindings(
    composeEffectiveBindings(defaults, { ...overrides, [commandId]: chord }),
  );
  const dropped = audit.dropped.find((entry) => entry.commandId === commandId);
  if (dropped !== undefined) {
    return refuseOverride("chord-unbindable", dropped.reason);
  }
  const conflict = audit.conflicts.find((entry) => entry.commandIds.includes(commandId));
  if (conflict !== undefined) {
    const holder = conflict.commandIds.find((id) => id !== commandId) ?? commandId;
    const holderTitle = input.commandTitle(holder) ?? "another command";
    return refuseOverride(
      "chord-taken",
      `${formatChordForPlatform(chord, platform)} already opens ${holderTitle}.`,
    );
  }
  return undefined;
}

function refuseOverride(
  code: KeybindingOverrideRefusalCode,
  detail: string,
): KeybindingOverrideRefusal {
  return refuse(KEYBINDING_OVERRIDE_REFUSAL_ORIGIN, code, detail);
}
