// What a rebinding IS: the override a person authored, the table it composes to, and
// whether one is admissible at all.
//
// `command-surface.ts` next door declares `FRAME_KEY_BINDINGS`, and that table stays
// exactly what it has always been — the chords the console ships. This module holds
// the other half. Two decisions carry it, and the store next door adds no third:
//
//   • **The effective table is composed, never edited.** The declared table and the
//     override map are two inputs to one pure function, so "what does this window
//     install" has a single answer that a test can compute without a store, a
//     database, or a DOM — and no code path mutates the shipped table in place.
//   • **A refusal is decided before anything is stored.** A candidate chord is
//     composed into the whole effective table and offered to the keybinding
//     service's own pre-flight check. Nothing here re-decides what a chord means or
//     when two collide: `keybinding-audit.ts` asks the service that will install it.
//
// Everything here is pure and synchronous. Who HOLDS the overrides, where they are
// kept, and what a window does while one is being recorded is
// `keybinding-override-store.ts`.

import { refuse, type ConsoleRefusal } from "../core/index.js";
import type { KeyBinding } from "./contributions.js";
import { HOST_CHORD_PLATFORM, type ChordPlatform } from "../primitives/index.js";
import { auditKeybindings, reservedChordReason } from "./keybinding-audit.js";

/**
 * What a person put on one command: a chord, or `null` for explicitly unbound.
 *
 * `null` says "this command has no chord and I meant that"; an ABSENT entry says "I
 * never touched this one", which is what a reset restores and what leaves the
 * shipped chord in place. The `keybinding` value class admits exactly this pair.
 */
export type KeybindingOverride = string | null;

/** Every override one window holds, keyed by command id. */
export type KeybindingOverrideMap = Readonly<Record<string, KeybindingOverride>>;

/** Why a candidate chord was refused. Rendered verbatim; never swallowed. */
export const KEYBINDING_OVERRIDE_REFUSAL_CODES = [
  "chord-reserved",
  "chord-unbindable",
  "chord-taken",
] as const;

/** One refusal code. Derived, so the vocabulary is declared exactly once. */
export type KeybindingOverrideRefusalCode = (typeof KEYBINDING_OVERRIDE_REFUSAL_CODES)[number];

/** The subsystem name every refusal this module raises carries. */
export const KEYBINDING_OVERRIDE_REFUSAL_ORIGIN = "keybinding-overrides";

/**
 * A typed refusal — the console's one refusal shape, narrowed on `code`.
 *
 * `core/refusal.ts` states the arrangement: each producer keeps its own closed code
 * union and widens at its boundary, so this renders through the same three refusal
 * renderings as a persistence refusal, with no translation where both are shown.
 */
export interface KeybindingOverrideRefusal extends ConsoleRefusal {
  readonly code: KeybindingOverrideRefusalCode;
}

function refuseOverride(
  code: KeybindingOverrideRefusalCode,
  detail: string,
): KeybindingOverrideRefusal {
  return refuse(KEYBINDING_OVERRIDE_REFUSAL_ORIGIN, code, detail);
}

/**
 * Apply an override map to a declared binding table.
 *
 * Three arms, each a decision: an absent entry leaves the shipped binding alone,
 * `null` drops it, a chord replaces it. An override for a command the table does not
 * bind APPENDS one, which is what makes a command shipping with no chord bindable at
 * all — ordered by command id, so two windows holding the same overrides install the
 * same table in the same order.
 */
export function composeEffectiveBindings(
  defaults: readonly KeyBinding[],
  overrides: KeybindingOverrideMap,
): readonly KeyBinding[] {
  const effective: KeyBinding[] = [];
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
 * Read a stored record back as an override map.
 *
 * Anything that is not the shape this seam writes answers the empty map: the
 * persistence chokepoint validated what it stored, so a record failing here is a
 * hand-edited database or a defect, and either way the honest recovery is the
 * shipped keyboard rather than half of somebody's.
 */
export function readOverrideMap(value: unknown): KeybindingOverrideMap {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  const map: Record<string, KeybindingOverride> = {};
  for (const [commandId, override] of Object.entries(value)) {
    if (override === null || typeof override === "string") {
      map[commandId] = override;
    }
  }
  return map;
}

/** What deciding a candidate chord needs beyond the chord and the command. */
export interface CandidateChordInput {
  /** The chords the console ships. Overrides are composed onto this table. */
  readonly defaults: readonly KeyBinding[];
  /** The overrides already held. The candidate is judged against them. */
  readonly overrides: KeybindingOverrideMap;
  readonly commandId: string;
  readonly chord: string;
  /** Whose reserved chords to refuse. Defaults to the host being run on. */
  readonly platform?: ChordPlatform;
}

/**
 * Would this chord install on this command, given these overrides?
 *
 * Reserved first, because a chord the host eats parses perfectly and would otherwise
 * be stored as a binding that can never fire. The other two verdicts are the
 * keybinding service's own, read off the whole candidate table rather than off the
 * one row: a chord is only free relative to everything else installed.
 */
export function refuseCandidateChord(
  input: CandidateChordInput,
): KeybindingOverrideRefusal | undefined {
  const { defaults, overrides, commandId, chord } = input;
  const reserved = reservedChordReason(chord, input.platform ?? HOST_CHORD_PLATFORM);
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
    return refuseOverride(
      "chord-taken",
      `${holder} already answers to this chord. ${conflict.detail}`,
    );
  }
  return undefined;
}
