// The keybinding table — the binding set, one listener, and the dispatch.
//
// WHAT IS ADOPTED AND WHAT IS OURS. `Spec-023 §Console Libraries`, the headless
// UI row: "ADOPT `tinykeys` 4.0.0 as the chord parser only … OWN-BUILD the
// keybinding service and when-clause grammar". The adopted half is walled off in
// `keybinding-chord.ts`; this module is the service, and it deliberately does NOT
// call `tinykeys()` itself, for three reasons that are requirements rather than
// preferences:
//
//   1. `tinykeys()` takes a STATIC map from chord to handler. Our bindings are
//      `when`-scoped, so which handler a chord resolves to is a function of the
//      live context, which that map cannot express.
//   2. Its handler skips events from text inputs through one global predicate.
//      Our guard is PER BINDING (`allowInTextInput`), because "open the palette"
//      must work while a person is typing in the composer and "delete the
//      selected row" must not.
//   3. It arms a `setTimeout` for multi-press sequences. We bind single-press
//      chords only (see `parseChord`), so no timer belongs on the console's input
//      path at all.
//
// ONE LISTENER, NOT ONE PER BINDING. `install` adds exactly one `keydown`
// listener however many bindings the table holds. Per-binding listeners would put
// N handlers on one target for one keystroke, make removal order-dependent, and —
// the part that actually breaks — let two bindings on one chord both fire,
// because neither would know the other had already handled the press. The single
// listener is also the only place that can arbitrate, which is what makes the
// conflict rule enforceable at all; the conflict rule itself is decided before
// installation, in `keybinding-conflicts.ts`.
//
// CAPTURE PHASE. The listener is installed with `capture: true` so the table sees
// a press before a focused widget can `stopPropagation` it. That is safe only
// because the per-binding text-entry guard runs first: the table declines the
// press rather than stealing it.

import { ConsoleRefusalError, refuse } from "../core/index.js";
import { isTextEntryTarget } from "../primitives/index.js";
import type { CommandInvocationOutcome, CommandRegistry } from "./command-registry.js";
import type { KeyBinding } from "./contributions.js";
import { chordMatchesEvent } from "./keybinding-chord.js";
import {
  detectConflicts,
  prepareBindings,
  type KeyBindingConflict,
  type KeyBindingDiagnostic,
  type PreparedBinding,
} from "./keybinding-conflicts.js";
import { evaluateWhenClause, type WhenClauseContext } from "./when-clause.js";

/** What happened when a chord fired. Reported, never swallowed. */
export type KeyBindingDispatch =
  | { readonly outcome: "ran"; readonly chord: string; readonly commandId: string }
  | {
      readonly outcome: "refused";
      readonly chord: string;
      readonly commandId: string;
      /**
       * Exactly the registry's non-running outcomes, DERIVED rather than restated.
       * The hand-written copy this replaced was mapped across with a ternary, so a
       * third refusal status added to `CommandInvocationOutcome` would have been
       * silently relabelled as `hidden-in-context` here — a dispatch record naming
       * the wrong reason, which is worse than none.
       */
      readonly reason: Exclude<CommandInvocationOutcome["status"], "ran">;
    };

/** Why the table refused a binding set. Rendered verbatim; never swallowed. */
export const KEY_BINDING_REFUSAL_CODES = ["chord-conflict"] as const;

/** One key-binding refusal code. Derived, so the vocabulary is declared once. */
export type KeyBindingRefusalCode = (typeof KEY_BINDING_REFUSAL_CODES)[number];

/** The subsystem name every refusal this module raises carries. */
export const KEY_BINDING_REFUSAL_ORIGIN = "keybindings";

/**
 * Thrown by `setBindings` when two bindings can be live on one chord.
 *
 * A `ConsoleRefusalError` and not a bare `Error`. `core/refusal.ts` names the
 * key-binding table as one of the five that had minted a refusal vocabulary of its
 * own, and the Keyboard settings page has to render this beside a persistence
 * refusal and a growth refusal — three shapes reaching three renderers was the cost.
 * It stays a named subclass and stays a THROW: `setBindings` replaces state, and a
 * conflict must abort that replacement rather than be returned beside a table that
 * has already half-changed.
 *
 * `conflicts` is kept beside the refusal because the settings page renders one row
 * per conflicting pair, which `detail`'s single sentence cannot carry.
 */
export class KeyBindingConflictError extends ConsoleRefusalError {
  public readonly conflicts: readonly KeyBindingConflict[];

  public constructor(conflicts: readonly KeyBindingConflict[]) {
    super(
      refuse(
        KEY_BINDING_REFUSAL_ORIGIN,
        // `satisfies` rather than a bare literal: this is the module's only
        // refusal site, so without it the closed vocabulary above binds nothing
        // and dropping a member from it would break no code at all. Checked
        // against the union, not widened to it.
        "chord-conflict" satisfies KeyBindingRefusalCode,
        `${String(conflicts.length)} keybinding conflict(s): ${conflicts
          .map((conflict) => `${conflict.chord} (${conflict.commandIds.join(" vs ")})`)
          .join(", ")}`,
      ),
    );
    this.name = "KeyBindingConflictError";
    this.conflicts = conflicts;
  }
}

/**
 * Anything a listener can be attached to. Narrowed to the two methods actually
 * used, so `Window`, `Document`, and any `HTMLElement` all satisfy it without a
 * union whose call signatures would have to be reconciled.
 */
export type KeyBindingTarget = Pick<EventTarget, "addEventListener" | "removeEventListener">;

/** How the table reaches the world. */
export interface KeyBindingTableOptions {
  readonly registry: CommandRegistry;
  /** Read the live context at dispatch time — never a snapshot taken at install. */
  readonly readContext: () => WhenClauseContext;
  /** Every dispatch decision, for diagnostics and for the Keyboard settings page. */
  readonly onDispatch?: (dispatch: KeyBindingDispatch) => void;
}

/**
 * The table.
 *
 * Stateful (bindings, the installed listener, the diagnostics of the last
 * `setBindings`), so it is a class: the install / dispose pairing and the
 * "exactly one listener" guarantee are invariants over that state, and they are
 * only checkable if the state has one owner.
 */
export class KeyBindingTable {
  readonly #registry: CommandRegistry;
  readonly #readContext: () => WhenClauseContext;
  readonly #onDispatch: ((dispatch: KeyBindingDispatch) => void) | undefined;
  #preparedBindings: readonly PreparedBinding[] = [];
  #diagnostics: readonly KeyBindingDiagnostic[] = [];
  #detachListener: (() => void) | undefined;

  public constructor(options: KeyBindingTableOptions) {
    this.#registry = options.registry;
    this.#readContext = options.readContext;
    this.#onDispatch = options.onDispatch;
  }

  /**
   * Replace the binding set.
   *
   * THROWS `KeyBindingConflictError` when two bindings can be live on one chord —
   * "an error surfaced at install time", because the alternative is one of them
   * silently never firing and a person concluding their keyboard is broken.
   *
   * DROPS, rather than throws on, a binding whose chord or `when` clause does not
   * parse: those are single bad rows (a hand-edited rebinding, a typo in a
   * settings file), and one bad row must not take the whole keyboard down. Each
   * drop is reported through `diagnostics()`, so the Keyboard page can render it.
   */
  public setBindings(bindings: readonly KeyBinding[]): void {
    const { prepared, diagnostics } = prepareBindings(bindings);

    const conflicts = detectConflicts(prepared);
    if (conflicts.length > 0) {
      throw new KeyBindingConflictError(conflicts);
    }

    // Most specific scope first, then registration order. After the conflict
    // check at most one of these can be live at a time, so the ordering is a
    // determinism guarantee rather than a precedence rule.
    this.#preparedBindings = [...prepared].sort(
      (left, right) => right.specificity - left.specificity || left.ordinal - right.ordinal,
    );
    this.#diagnostics = diagnostics;
  }

  /**
   * Check a candidate binding set WITHOUT installing it.
   *
   * The Keyboard settings page offers rebinding with conflict detection, and it
   * needs the answer before it commits — asking by catching the throw from
   * `setBindings` would mean the table had already been half-replaced.
   */
  public static conflictsIn(bindings: readonly KeyBinding[]): readonly KeyBindingConflict[] {
    return detectConflicts(prepareBindings(bindings).prepared);
  }

  /** Bindings dropped by the last `setBindings`, with the reason for each. */
  public diagnostics(): readonly KeyBindingDiagnostic[] {
    return this.#diagnostics;
  }

  /** Every installed binding for a command, in dispatch order. */
  public bindingsFor(commandId: string): readonly KeyBinding[] {
    return this.#preparedBindings
      .filter((prepared) => prepared.binding.commandId === commandId)
      .map((prepared) => prepared.binding);
  }

  /**
   * The chord to print beside a command right now, or `undefined` when none of its
   * bindings is live in this context. Printing a chord that would not fire is a
   * lie the palette must not tell.
   */
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
   * Attach THE listener. Returns a disposer; calling `install` twice without
   * disposing is a wiring bug and throws, because two live listeners would run
   * every command twice per press.
   *
   * EACH DISPOSER DETACHES ITS OWN INSTALLATION AND CLEARS THE FIELD ONLY WHILE
   * IT STILL OWNS IT. A disposer outlives its installation — a React effect's
   * cleanup is held for as long as the closure that captured it — so a stale one
   * can be called after the table has been installed again. Clearing the field
   * unconditionally let that call report the table uninstalled while the NEWER
   * listener was still attached: the next `install` was then admitted, two live
   * listeners ran every command twice per press, and the disposer for the
   * orphaned one had already been dropped. The identity check is what makes
   * `installed` and the guard above true statements about the CURRENT
   * installation, and it makes each disposer idempotent for free —
   * `removeEventListener` is a no-op for a listener already removed.
   */
  public install(target: KeyBindingTarget): () => void {
    if (this.#detachListener !== undefined) {
      throw new Error(
        "this KeyBindingTable is already installed; dispose the previous installation before installing again",
      );
    }
    const listener = (event: Event): void => {
      if (event instanceof KeyboardEvent) {
        this.handleKeyDown(event);
      }
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
   * The listener body. Public so a unit test drives the REAL dispatch path rather
   * than a reimplementation of it.
   *
   * Returns whether the press was consumed.
   */
  public handleKeyDown(event: KeyboardEvent): boolean {
    // A held key repeats; a chord is one act, so an auto-repeat must not run a
    // command per repeat frame. An IME composition keystroke belongs to the text
    // being composed and never to a chord.
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
    // The clause evaluator lives in `when-clause.ts` and is called from here
    // rather than re-implemented: a keyboard scope that disagreed with a command's
    // `when` about the same clause would make a chord fire a command the palette
    // says is hidden.
    return evaluateWhenClause(prepared.whenAst, context);
  }

  #dispatch(prepared: PreparedBinding, event: KeyboardEvent, context: WhenClauseContext): boolean {
    const { chord, commandId } = prepared.binding;
    const outcome = this.#registry.invoke(commandId, context);
    if (outcome.status === "ran") {
      // Only a press that actually ran something is consumed. A refused binding
      // leaves the key to whatever else wanted it, which is the difference
      // between "the console handled this" and "the console ate this".
      event.preventDefault();
      event.stopPropagation();
      this.#onDispatch?.({ outcome: "ran", chord, commandId });
      return true;
    }
    // `outcome.status` is already narrowed to the non-running arms by the return
    // above, so it IS the reason. The ternary this replaced re-derived the same two
    // values by hand and would have mapped a third status onto the wrong one.
    this.#onDispatch?.({ outcome: "refused", chord, commandId, reason: outcome.status });
    return false;
  }
}
