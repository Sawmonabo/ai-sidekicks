// What can be decided about a candidate binding set BEFORE it is installed.
//
// Two questions, and they are the same pass: which rows are well formed at all,
// and which surviving pairs could fire on one keystroke. Both are answered here
// rather than inside `KeyBindingTable` because the Keyboard settings page needs
// them without committing — `KeyBindingTable.conflictsIn` is a pre-flight check,
// and asking by catching the throw from `setBindings` would mean the table had
// already been half-replaced.
//
// The `KeyBinding` type this module validates is declared in `keybindings.ts`,
// the module that installs one. The import below is type-only and erased, so the
// runtime edge runs one way: the table reaches down here, and nothing here
// reaches back.

import type { KeybindingPress } from "tinykeys";
import type { KeyBinding } from "./contributions.js";
import { normalizePressForComparison, parseChord } from "./keybinding-chord.js";
import {
  collectWhenClauseIdentifiers,
  formatWhenClause,
  type WhenClauseNode,
} from "./when-clause.js";
import { whenClausesCanOverlap } from "./when-clause-overlap.js";
import { parseWhenClause } from "./when-clause-parser.js";

/** Two bindings that can be live on one chord at one moment. */
export interface KeyBindingConflict {
  readonly chord: string;
  readonly commandIds: readonly [string, string];
  /**
   * `overlapping-scope`: a context exists in which both are live.
   * `undecidable-scope`: their scopes name more context keys than the overlap
   * check enumerates, so disjointness is unproven — treated as a conflict,
   * because an unproven separation is not a separation.
   */
  readonly reason: "overlapping-scope" | "undecidable-scope";
  readonly detail: string;
}

/** A binding that was dropped rather than installed, with the reason. */
export interface KeyBindingDiagnostic {
  readonly binding: KeyBinding;
  readonly reason: "chord-unparseable" | "when-unparseable";
  readonly detail: string;
}

/** A binding that survived validation, with its clause and chord already parsed. */
export interface PreparedBinding {
  readonly binding: KeyBinding;
  readonly press: KeybindingPress;
  readonly whenAst: WhenClauseNode | undefined;
  /** Registration order, the last stable key in the dispatch ordering. */
  readonly ordinal: number;
  /** How many distinct context keys the scope names — more keys is a narrower scope. */
  readonly specificity: number;
}

/** Everything one validation pass over a candidate set establishes. */
export interface PreparedBindingSet {
  readonly prepared: readonly PreparedBinding[];
  readonly diagnostics: readonly KeyBindingDiagnostic[];
}

/**
 * Validate and parse a candidate binding set once.
 *
 * Shared by `setBindings` and the static `conflictsIn` so the settings page's
 * pre-flight check and the real install cannot disagree about which bindings are
 * well formed — a preview that validated differently from the commit would be a
 * second source of truth for the same question.
 */
export function prepareBindings(bindings: readonly KeyBinding[]): PreparedBindingSet {
  const prepared: PreparedBinding[] = [];
  const diagnostics: KeyBindingDiagnostic[] = [];

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
 * Find every pair of bindings that can be live on one chord at one moment.
 *
 * Grouping is by the PARSED chord rather than by the chord string, so `$mod+k`
 * and `$mod+KeyK` — two spellings of one keystroke — are compared against each
 * other instead of passing as unrelated. Scope disjointness is decided by
 * `whenClausesCanOverlap`, which enumerates: `paneFocused` and `!paneFocused` on
 * one chord are two scopes and no conflict, while `sessionOpen` and
 * `sessionOpen && paneFocused` are a conflict even though they are spelled
 * differently.
 */
export function detectConflicts(
  prepared: readonly PreparedBinding[],
): readonly KeyBindingConflict[] {
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

  const conflicts: KeyBindingConflict[] = [];
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
              ? `Both bindings are live at once in at least one context (${describeScope(left)} and ${describeScope(right)})`
              : `The two scopes name too many context keys to prove they never overlap (${describeScope(left)} and ${describeScope(right)})`,
        });
      }
    }
  }
  return conflicts;
}

function describeScope(prepared: PreparedBinding): string {
  // The CANONICAL rendering, not the author's source text. Two bindings whose
  // scopes are one clause spelled two ways — `a&&b` against `a && b`, `!(x)`
  // against `!x` — genuinely conflict, and a report quoting both spellings reads
  // as though it had found two different scopes and then called them overlapping.
  // Rendering from the parsed clause makes one clause read one way, which is the
  // only reason `formatWhenClause` exists.
  return prepared.whenAst === undefined ? "always" : formatWhenClause(prepared.whenAst);
}
