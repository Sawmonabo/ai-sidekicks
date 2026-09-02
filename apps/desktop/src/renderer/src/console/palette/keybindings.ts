// The keybinding table — the chord grammar, the binding set, and one listener.
//
// WHAT IS ADOPTED AND WHAT IS OURS. `Spec-023 §Console Libraries`, the headless
// UI row: "ADOPT `tinykeys` 4.0.0 as the chord parser only … OWN-BUILD the
// keybinding service and when-clause grammar". So this module imports exactly two
// things from tinykeys — `parseKeybinding`, which turns `"$mod+KeyK"` into
// modifier sets and a key, and `matchKeybindingPress`, which decides whether one
// `KeyboardEvent` satisfies one parsed press — and builds the service around
// them. It deliberately does NOT call `tinykeys()` itself, for three reasons that
// are requirements rather than preferences:
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
// conflict rule below enforceable at all.
//
// CAPTURE PHASE. The listener is installed with `capture: true` so the table sees
// a press before a focused widget can `stopPropagation` it. That is safe only
// because the per-binding text-entry guard runs first: the table declines the
// press rather than stealing it.
//
// WHAT IS NOT HERE. How a chord is PRINTED and SPOKEN lives in
// `primitives/chord-format.ts`. A keycap is a renderer's concern and primitives
// are below palette in the console's import graph, so keeping the tables here
// forced `ChordHint` to reach up into this family for its vocabulary. The one
// symbol that has to be shared is imported below, and it is shared rather than
// duplicated because the printer and the conflict comparator disagreeing about
// whether `k` and `KeyK` are one keystroke is the exact defect it prevents.

import { matchKeybindingPress, parseKeybinding, type KeybindingPress } from "tinykeys";
import { ConsoleRefusalError, refuse } from "../core/index.js";
import { decodeChordKeyToken } from "../primitives/index.js";
import type { CommandInvocationOutcome, CommandRegistry } from "./command-registry.js";
import {
  collectWhenClauseIdentifiers,
  evaluateWhenClause,
  parseWhenClause,
  whenClausesCanOverlap,
  type WhenClauseContext,
  type WhenClauseNode,
} from "./when-clause.js";

/** One chord bound to one command, optionally scoped. */
export interface KeyBinding {
  /** tinykeys syntax, single press, `$mod` for Cmd on macOS and Ctrl elsewhere. */
  readonly chord: string;
  readonly commandId: string;
  /** A `when-clause.ts` expression. Absent means the binding is always live. */
  readonly when?: string;
  /**
   * Fire even while focus is in a text field. Default false.
   *
   * Opt-in rather than opt-out because the failure modes are asymmetric: a chord
   * that wrongly fires while someone is typing destroys their text, and a chord
   * that wrongly declines makes them reach for a menu.
   */
  readonly allowInTextInput?: boolean;
}

/** Why a chord string was refused. */
export type ChordParseErrorKind = "empty-chord" | "sequence-unsupported" | "no-key";

/** A chord that parsed, or the reason it did not. */
export type ChordParseResult =
  | { readonly ok: true; readonly press: KeybindingPress }
  | { readonly ok: false; readonly kind: ChordParseErrorKind; readonly message: string };

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

/** What happened when a chord fired. Reported, never swallowed. */
export type KeyBindingDispatch =
  | { readonly outcome: "ran"; readonly chord: string; readonly commandId: string }
  | { readonly outcome: "no-live-binding"; readonly chord: string }
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
 * `<input>` types that are controls rather than text entry. A checkbox or a
 * radio should still receive a chord; a search field should not.
 */
const NON_TEXT_INPUT_TYPES = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
]);

/**
 * Parse a chord into the single press the table matches against.
 *
 * MULTI-PRESS SEQUENCES ARE REFUSED. tinykeys can express `"g d"`, and honouring
 * it would require a pending-press map behind a timeout — a timer on the
 * console's input path, which `Spec-023 §Console Design (Meridian)` §The four
 * bars rules out ("no timer fires except the refresh scheduler's deadline and the
 * presence heartbeat"). The grammar that spec names is a CHORD grammar, so a
 * sequence is refused loudly at install rather than half-supported at runtime.
 */
export function parseChord(chord: string): ChordParseResult {
  const trimmed = chord.trim();
  if (trimmed.length === 0) {
    return { ok: false, kind: "empty-chord", message: "The chord is empty" };
  }
  const presses = parseKeybinding(trimmed);
  if (presses.length > 1) {
    return {
      ok: false,
      kind: "sequence-unsupported",
      message: `"${trimmed}" is a multi-press sequence; the console binds single chords only`,
    };
  }
  const press = presses[0];
  if (press === undefined) {
    return { ok: false, kind: "empty-chord", message: "The chord is empty" };
  }
  const key = press[2];
  if (typeof key === "string" && key.length === 0) {
    return { ok: false, kind: "no-key", message: `"${trimmed}" names modifiers but no key` };
  }
  return { ok: true, press };
}

/** Does this event satisfy this parsed chord? Thin, so tinykeys owns the semantics. */
export function chordMatchesEvent(press: KeybindingPress, event: KeyboardEvent): boolean {
  return matchKeybindingPress(event, press);
}

/**
 * Is this event coming out of a text field?
 *
 * `isContentEditable` covers the composer and any rich editor; the tag check
 * covers native fields. `type` is consulted so a chord still reaches a checkbox,
 * which is a control rather than a place text is being typed.
 */
export function isTextEntryTarget(target: EventTarget | null): boolean {
  if (target === null || !(target instanceof HTMLElement)) {
    return false;
  }
  if (target.isContentEditable) {
    return true;
  }
  const tagName = target.tagName;
  if (tagName === "TEXTAREA" || tagName === "SELECT") {
    return true;
  }
  if (tagName !== "INPUT") {
    return false;
  }
  const inputType = target.getAttribute("type")?.toLowerCase() ?? "text";
  return !NON_TEXT_INPUT_TYPES.has(inputType);
}

/** A binding that survived validation, with its clause and chord already parsed. */
interface PreparedBinding {
  readonly binding: KeyBinding;
  readonly press: KeybindingPress;
  readonly whenAst: WhenClauseNode | undefined;
  /** Registration order, the last stable key in the dispatch ordering. */
  readonly ordinal: number;
  /** How many distinct context keys the scope names — more keys is a narrower scope. */
  readonly specificity: number;
}

/**
 * Validate and parse a candidate binding set once.
 *
 * Shared by `setBindings` and the static `conflictsIn` so the settings page's
 * pre-flight check and the real install cannot disagree about which bindings are
 * well formed — a preview that validated differently from the commit would be a
 * second source of truth for the same question.
 */
function prepareBindings(bindings: readonly KeyBinding[]): {
  prepared: readonly PreparedBinding[];
  diagnostics: readonly KeyBindingDiagnostic[];
} {
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
      this.#detachListener = undefined;
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
function detectConflicts(prepared: readonly PreparedBinding[]): readonly KeyBindingConflict[] {
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
  return prepared.binding.when ?? "always";
}

/**
 * A comparison key for a parsed press: required modifiers, optional modifiers,
 * and the key, each normalised so two spellings of one keystroke collide. A
 * regular-expression key is compared by its source, which is exact for the
 * spellings tinykeys produces.
 */
function normalizePressForComparison(press: KeybindingPress): string {
  const [requiredModifiers, optionalModifiers, key] = press;
  const required = [...requiredModifiers].sort().join("+");
  const optional = [...optionalModifiers].sort().join("+");
  const keyText = typeof key === "string" ? normalizeKeyToken(key) : `re:${key.source}`;
  return `${required}|${optional}|${keyText}`;
}

function normalizeKeyToken(key: string): string {
  return decodeChordKeyToken(key).toUpperCase();
}
