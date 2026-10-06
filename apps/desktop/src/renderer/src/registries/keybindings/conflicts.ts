// What can be decided about a candidate binding set before it is installed: which rows are well
// formed, and which surviving pairs could fire on one keystroke. It lives outside `KeybindingTable`
// so the Keyboard settings page can ask without committing.

import type { KeybindingPress } from "tinykeys";
import type { Keybinding } from "../commands/keybinding.js";
import { normalizePressForComparison, parseChord } from "./chord.js";
import {
  collectWhenClauseIdentifiers,
  formatWhenClause,
  type WhenClauseNode,
} from "../commands/when-clause/semantics.js";
import { parseWhenClause } from "../commands/when-clause/parser.js";
import { whenClausesCanOverlap } from "../commands/when-clause/overlap.js";

/** Two bindings that can be live on one chord at one moment. */
export interface KeybindingConflict {
  readonly chord: string;
  readonly commandIds: readonly [string, string];
  /**
   * `overlapping-scope`: a context exists in which both are live. `undecidable-scope`: the
   * scopes name more context keys than the overlap check enumerates, so disjointness is
   * unproven and counts as a conflict.
   */
  readonly reason: "overlapping-scope" | "undecidable-scope";
  readonly detail: string;
}

/** A binding that was dropped rather than installed, with the reason. */
export interface KeybindingDiagnostic {
  readonly binding: Keybinding;
  readonly reason: "chord-unparseable" | "when-unparseable";
  readonly detail: string;
}

/** A binding that survived validation, with its clause and chord already parsed. */
export interface PreparedBinding {
  readonly binding: Keybinding;
  readonly press: KeybindingPress;
  readonly whenAst: WhenClauseNode | undefined;
  /** Registration order, the last tie-break in dispatch ordering. */
  readonly ordinal: number;
  /** How many distinct context keys the scope names; more keys is a narrower scope. */
  readonly specificity: number;
}

/** Everything one validation pass over a candidate set establishes. */
export interface PreparedBindingSet {
  readonly prepared: readonly PreparedBinding[];
  readonly diagnostics: readonly KeybindingDiagnostic[];
}

/**
 * Validates and parses a candidate binding set once. `setBindings` and `conflictsIn` share it so
 * a preview and the real install cannot disagree about which bindings are well formed.
 */
export function prepareBindings(bindings: readonly Keybinding[]): PreparedBindingSet {
  const prepared: PreparedBinding[] = [];
  const diagnostics: KeybindingDiagnostic[] = [];

  bindings.forEach((binding, index) => {
    const chord = parseChord(binding.chord);
    if (!chord.ok) {
      diagnostics.push({ binding, reason: "chord-unparseable", detail: chord.message });
      return;
    }
    let whenAst: WhenClauseNode | undefined;
    if (binding.when !== undefined) {
      const parsed = parseWhenClause(binding.when);
      if (!parsed.ok) {
        diagnostics.push({ binding, reason: "when-unparseable", detail: parsed.error.message });
        return;
      }
      whenAst = parsed.ast;
    }
    prepared.push({
      binding,
      press: chord.press,
      whenAst,
      ordinal: index,
      specificity: whenAst === undefined ? 0 : collectWhenClauseIdentifiers(whenAst).length,
    });
  });

  return { prepared, diagnostics };
}

/**
 * Finds every pair of bindings that can be live on one chord at once. Grouping is by the parsed
 * chord, so `$mod+k` and `$mod+KeyK` are compared; scope overlap is decided by
 * `whenClausesCanOverlap`.
 */
export function detectConflicts(
  prepared: readonly PreparedBinding[],
): readonly KeybindingConflict[] {
  const byNormalizedChord = new Map<string, PreparedBinding[]>();
  for (const candidate of prepared) {
    const key = normalizePressForComparison(candidate.press);
    const bucket = byNormalizedChord.get(key);
    if (bucket === undefined) {
      byNormalizedChord.set(key, [candidate]);
    } else {
      bucket.push(candidate);
    }
  }

  const conflicts: KeybindingConflict[] = [];
  for (const bucket of byNormalizedChord.values()) {
    for (let leftIndex = 0; leftIndex < bucket.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < bucket.length; rightIndex += 1) {
        const left = bucket[leftIndex];
        const right = bucket[rightIndex];
        if (left === undefined || right === undefined) {
          continue;
        }
        const overlap = whenClausesCanOverlap(left.whenAst, right.whenAst);
        if (overlap === "disjoint") {
          continue;
        }
        conflicts.push({
          chord: left.binding.chord,
          commandIds: [left.binding.commandId, right.binding.commandId],
          reason: overlap === "overlap" ? "overlapping-scope" : "undecidable-scope",
          detail:
            overlap === "overlap"
              ? `Both bindings are live at once in at least one context ` +
                `(${describeScope(left)} and ${describeScope(right)})`
              : `The two scopes name too many context keys to prove they never ` +
                `overlap (${describeScope(left)} and ${describeScope(right)})`,
        });
      }
    }
  }
  return conflicts;
}

function describeScope(prepared: PreparedBinding): string {
  // Canonical rendering, so one clause spelled two ways (`a&&b`, `a && b`) reads one way.
  return prepared.whenAst === undefined ? "always" : formatWhenClause(prepared.whenAst);
}
