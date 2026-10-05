// The binding set, one listener and the dispatch. Chord parsing is tinykeys via
// `keybinding-chord.ts`; `tinykeys()` itself is not used because:
//
//   1. It takes a static chord-to-handler map, but our bindings are `when`-scoped, so the handler
//      depends on the live context.
//   2. It skips text inputs with one global predicate; ours is per binding (`allowInTextInput`),
//      so "open the palette" works while typing and "delete the selected row" does not.
//   3. It arms a `setTimeout` for multi-press sequences; only single-press chords are bound.
//
// `install` adds exactly one `keydown` listener, not one per binding: separate listeners could
// let two bindings on one chord both fire. Conflicts are decided before install, in
// `keybinding-conflicts.ts`. The listener uses the capture phase so a focused widget cannot
// `stopPropagation` a press first; the text-entry guard runs first, so the table declines
// a press rather than stealing it.

import { RefusalError, refuse } from "@renderer/lib/refusal/refusal.js";
import { isTextEntryTarget } from "@renderer/lib/editable-target.js";
import type { CommandRegistry } from "../commands/command-registry.js";
import type { Keybinding } from "../commands/command-types.js";
import { chordMatchesEvent } from "./keybinding-chord.js";
import {
  detectConflicts,
  prepareBindings,
  type KeybindingConflict,
  type KeybindingDiagnostic,
  type PreparedBinding,
} from "./keybinding-conflicts.js";
import { evaluateWhenClause, type WhenClauseContext } from "../commands/when-clause/when-clause.js";

/** Why the table refused a binding set. Rendered verbatim; never swallowed. */
export const KEYBINDING_REFUSAL_CODES = ["chord-conflict"] as const;

/** One keybinding refusal code. */
export type KeybindingRefusalCode = (typeof KEYBINDING_REFUSAL_CODES)[number];

/** The subsystem name every refusal this module raises carries. */
export const KEYBINDING_REFUSAL_ORIGIN = "keybindings";

/**
 * Anything a keydown listener can be attached to: any window's `Window`, `Document` or element.
 * Typed by the event it delivers rather than checked with `instanceof`, since each window has its
 * own `KeyboardEvent`.
 */
export interface KeybindingTarget {
  addEventListener(
    type: "keydown",
    listener: (event: KeyboardEvent) => void,
    options: AddEventListenerOptions,
  ): void;
  removeEventListener(
    type: "keydown",
    listener: (event: KeyboardEvent) => void,
    options: EventListenerOptions,
  ): void;
}

/** How the table reaches the world. */
export interface KeybindingTableOptions {
  readonly registry: CommandRegistry;
  /** Reads the live context at dispatch time, never a snapshot taken at install. */
  readonly readContext: () => WhenClauseContext;
}

/**
 * Thrown by `setBindings` when two bindings can be live on one chord. A `RefusalError` so the
 * settings page renders it like any refusal; it throws so the conflict aborts the replacement.
 * `conflicts` carries one entry per pair for the page's rows.
 */
export class KeybindingConflictError extends RefusalError {
  public readonly conflicts: readonly KeybindingConflict[];

  public constructor(conflicts: readonly KeybindingConflict[]) {
    super(
      refuse(
        KEYBINDING_REFUSAL_ORIGIN,
        // `satisfies` ties this literal to the closed vocabulary above.
        "chord-conflict" satisfies KeybindingRefusalCode,
        `${String(conflicts.length)} keybinding conflict(s): ${conflicts
          .map((conflict) => `${conflict.chord} (${conflict.commandIds.join(" vs ")})`)
          .join(", ")}`,
      ),
    );
    this.name = "KeybindingConflictError";
    this.conflicts = conflicts;
  }
}

/** The binding table: installed bindings, at most one listener, and the last diagnostics. */
export class KeybindingTable {
  readonly #registry: CommandRegistry;
  readonly #readContext: () => WhenClauseContext;
  #preparedBindings: readonly PreparedBinding[] = [];
  #diagnostics: readonly KeybindingDiagnostic[] = [];
  #detachListener: (() => void) | undefined;

  public constructor(options: KeybindingTableOptions) {
    this.#registry = options.registry;
    this.#readContext = options.readContext;
  }

  /**
   * Replaces the binding set. Throws `KeybindingConflictError` when two bindings can be live on
   * one chord. A binding whose chord or `when` clause does not parse is dropped, not thrown on,
   * so one bad row cannot take the keyboard down; drops are reported by `diagnostics()`.
   */
  public setBindings(bindings: readonly Keybinding[]): void {
    const { prepared, diagnostics } = prepareBindings(bindings);

    const conflicts = detectConflicts(prepared);
    if (conflicts.length > 0) {
      throw new KeybindingConflictError(conflicts);
    }

    // Most specific scope first, then registration order; after the conflict check at most one is
    // live, so this only makes dispatch deterministic.
    this.#preparedBindings = [...prepared].sort(
      (left, right) => right.specificity - left.specificity || left.ordinal - right.ordinal,
    );
    this.#diagnostics = diagnostics;
  }

  /** Checks a candidate set for conflicts without installing it, so the caller can decide first. */
  public static conflictsIn(bindings: readonly Keybinding[]): readonly KeybindingConflict[] {
    return detectConflicts(prepareBindings(bindings).prepared);
  }

  /** Bindings dropped by the last `setBindings`, with the reason for each. */
  public diagnostics(): readonly KeybindingDiagnostic[] {
    return this.#diagnostics;
  }

  /** The chord to print beside a command now, or `undefined` when none of its bindings is live. */
  public chordFor(commandId: string, context: WhenClauseContext): string | undefined {
    for (const prepared of this.#preparedBindings) {
      if (prepared.binding.commandId !== commandId) {
        continue;
      }
      if (this.#isLive(prepared, context)) {
        return prepared.binding.chord;
      }
    }
    return undefined;
  }

  /**
   * Attaches the one listener and returns its disposer. Installing twice without disposing throws,
   * since two listeners would run every command twice. A disposer clears the installed marker only
   * while it still owns it, so a stale disposer cannot report the table uninstalled.
   */
  public install(target: KeybindingTarget): () => void {
    if (this.#detachListener !== undefined) {
      throw new Error(
        "this KeybindingTable is already installed; dispose " +
          "the previous installation before installing again",
      );
    }
    const listener = (event: KeyboardEvent): void => {
      this.handleKeyDown(event);
    };
    target.addEventListener("keydown", listener, { capture: true });
    const detach = (): void => {
      target.removeEventListener("keydown", listener, { capture: true });
      if (this.#detachListener === detach) {
        this.#detachListener = undefined;
      }
    };
    this.#detachListener = detach;
    return detach;
  }

  /** Whether a listener is currently attached. */
  public get installed(): boolean {
    return this.#detachListener !== undefined;
  }

  /**
   * The listener body, public so tests drive the real dispatch path. Returns whether the press was
   * consumed.
   */
  public handleKeyDown(event: KeyboardEvent): boolean {
    // Auto-repeat must not rerun a command, and an IME composition keystroke is never a chord.
    if (event.repeat || event.isComposing) {
      return false;
    }

    const inTextEntry = isTextEntryTarget(event.target);
    const context = this.#readContext();

    for (const prepared of this.#preparedBindings) {
      if (inTextEntry && prepared.binding.allowInTextInput !== true) {
        continue;
      }
      if (!chordMatchesEvent(prepared.press, event)) {
        continue;
      }
      if (!this.#isLive(prepared, context)) {
        continue;
      }
      return this.#dispatch(prepared, event, context);
    }
    return false;
  }

  #isLive(prepared: PreparedBinding, context: WhenClauseContext): boolean {
    if (prepared.whenAst === undefined) {
      return true;
    }
    // The shared evaluator, so a chord never fires a command the palette hides.
    return evaluateWhenClause(prepared.whenAst, context);
  }

  #dispatch(prepared: PreparedBinding, event: KeyboardEvent, context: WhenClauseContext): boolean {
    const outcome = this.#registry.invoke(prepared.binding.commandId, context);
    if (outcome.status !== "ran") {
      // Only a press that ran something is consumed; a refused binding leaves the key to others.
      return false;
    }
    event.preventDefault();
    event.stopPropagation();
    return true;
  }
}
