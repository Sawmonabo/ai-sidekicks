// The command palette.
//
// COMPOSITION. `Spec-023 §Console Libraries` adopts `@base-ui/react` 1.7.0 as
// "the one widget family … including combobox and autocomplete", so the palette
// is `Combobox.Root` in `inline` mode wrapping a `Dialog.Root` — the composition
// that package's own `ComboboxRoot` documentation names: bind the combobox's
// `open` / `onOpenChange` to the dialog's, and it resets its transient state
// (filter query, highlight, input value) when the dialog closes. Combobox owns
// the `combobox` / `listbox` / `option` roles, `aria-activedescendant`, arrow and
// Home/End navigation, and Enter-on-highlighted; Dialog owns the focus trap,
// Escape, outside press, and the portal. None of that is re-implemented here,
// which is the whole reason the family was adopted.
//
// Two deviations from the library defaults, both required by the spec:
//
//   • `modal="trap-focus"` rather than `modal` (the default `true`). Focus is
//     trapped, but the document's scroll is NOT locked — `Spec-023 §Console
//     Libraries` says "no body scroll lock" in the same row that adopts this
//     family. Trapping focus is not the same guarantee as leaving the app root:
//     a reader navigating by structure still reaches the rail and the surface
//     underneath. The `inert` that closes that gap is the shell's rather than the
//     palette's — this component cannot know what "the rest of the app" is, and a
//     dialog that inerted its own container would leave nothing reachable at all
//     — so the frame carries it on the background wrapper it renders around
//     everything but its overlay slot, for exactly as long as the same `open`
//     this component is controlled by.
//   • `filter={null}`. The registry has already filtered and RANKED; letting the
//     combobox filter again would put a second matcher in the console, and
//     "one matcher shared with settings search" is a claim about the whole app.
//
// A CLOSED PALETTE IS DORMANT, and that is a cost claim rather than a style one.
// The registry's search and its visible-command count are the two things here that
// walk every registered command, and both used to run on every render of the frame
// — a palette nobody had opened re-ranked the whole command set each time the route,
// the context, or a late registration moved. Both are gated on `open` now and answer
// from a frozen empty result while closed, which is what makes "evaluates nothing
// while closed" true rather than aspirational.
//
// AND THE SCOPE IS CAPTURED, NOT TRACKED. The row naming what these commands will
// act on is latched at the moment the palette opens and never re-resolved while it
// is open: a person reads "acting on X", types, and presses Enter, and the target
// must be the one they read — not whatever the frame's route happened to resolve to
// in between.
//
// THE CAPTURE IS THE ROW AND THE CONTEXT, and capturing the row alone was worse than
// capturing nothing: the search still recomputed against the live `context` and the
// dispatch still handed that one to `registry.invoke`, so a route change under an open
// palette displayed "acting on X" over Y's rows, ready to act on Y. Everything on screen
// reads the one captured reading now, and a command that has left the registry since
// refuses inline — `palette-latch.ts` holds the reading, the dispatch, and why both.
//
// WHAT IS NOT HERE. The rows are `PaletteResultList.tsx` and the five kinds of
// nothing are `PaletteAbsence.tsx`. This module is the composition, the query
// state, and the one chord that opens the whole thing.

import { Combobox } from "@base-ui/react/combobox";
import { Dialog } from "@base-ui/react/dialog";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PALETTE_RESULT_CAP } from "../core/index.js";
import type { ShellMutationBlock } from "../store/index.js";
import {
  COMMAND_PALETTE_OPEN_CHORD,
  InlineRefusal,
  formatChordForPlatform,
  formatCount,
  type ChordPlatform,
} from "../primitives/index.js";
import type { CommandSearchResult } from "./command-ranking.js";
import type { CommandRegistry } from "./command-registry.js";
import { chordMatchesEvent, parseChord } from "./keybinding-chord.js";
import type { KeyBindingTable, KeyBindingTarget } from "./keybindings.js";
import { PaletteAbsence, type PaletteReadiness } from "./PaletteAbsence.js";
import { PaletteResultList, groupResults } from "./PaletteResultList.js";
import {
  runLatchedCommand,
  type LatchedPaletteScope,
  type PaletteInvocationRefusal,
  type PaletteRowPressOutcome,
} from "./palette-latch.js";
import type { WhenClauseContext } from "./when-clause.js";

export interface PaletteOverlayProps {
  readonly registry: CommandRegistry;
  /**
   * The context keys — live on the way in and CAPTURED at the open transition, so a
   * caller recomputing them on every route change moves nothing under a person who is
   * mid-keystroke. Drives visibility, the printed chord, and what the act runs against.
   */
  readonly context: WhenClauseContext;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Which chord convention to print. Passed in so a fixture can pin it. */
  readonly platform: ChordPlatform;
  /** Supplies each row's chord. Omit and rows print no chord rather than a wrong one. */
  readonly bindings?: KeyBindingTable;
  /**
   * The scoped-context row: what these commands act on.
   *
   * Read once, when the palette opens, together with `context` — the two are one
   * reading. A caller may recompute either as often as it likes; what a person sees is
   * what it said at the moment they summoned this, and what runs is what it named.
   */
  readonly scopeLabel?: string;
  /**
   * Why the shell is refusing mutating operations, where it is.
   *
   * NAMED AND NEVER ENFORCED HERE. The palette still lists every mutating command
   * while the shell is read-only, because hiding them would hide the cause and
   * leave a person hunting for a control that is on screen everywhere else. The
   * dispatch renders the refusal; this line says in advance what it will say.
   */
  readonly shellBlock?: ShellMutationBlock;
  readonly readiness?: PaletteReadiness;
  /**
   * Bump to recompute results after late registration. The registry is a mutable
   * object, so React cannot see a `register` call; this is the frame's way of
   * saying "the command set changed" without making the registry a store.
   */
  readonly revision?: number;
  /** Where popups portal. The frame's overlay root; `undefined` falls back to `<body>`. */
  readonly overlayContainer?: HTMLElement | null;
  /** Listener target for the open chord. Defaults to `window`. */
  readonly chordTarget?: KeyBindingTarget;
}

/**
 * The palette.
 *
 * Controlled on `open`: the frame decides whether it is showing, and the palette
 * asks for a change. The open chord installs ONE listener of its own rather than
 * riding `KeyBindingTable`, because it is shell chrome and not a contributed
 * command — it has to work before any family has registered anything, and it has
 * to work while a person is typing in the composer.
 */
export function PaletteOverlay(props: PaletteOverlayProps): React.JSX.Element {
  const {
    registry,
    context,
    open,
    onOpenChange,
    platform,
    bindings,
    scopeLabel,
    shellBlock,
    readiness = { status: "ready" },
    revision,
    overlayContainer,
    chordTarget,
  } = props;

  const [query, setQuery] = useState("");
  const [invocationRefusal, setInvocationRefusal] = useState<PaletteInvocationRefusal | undefined>(
    undefined,
  );
  const inputRef = useRef<HTMLInputElement | null>(null);

  // The reading, latched at the open transition — the label and the context together.
  //
  // Adjusted DURING RENDER rather than in an effect, which is the documented React
  // shape for state derived from a prop change and the only one that is correct here:
  // an effect runs after the commit, so the first frame of an open palette would print
  // the scope from the last time it was open — precisely the stale target this latch
  // prevents, shown at the one moment a person is reading it. It sits above the memos
  // because they consume what it captured, and both fields are RETAINED on close so the
  // closing frame renders what the open one did rather than flashing the route the
  // palette is being dismissed onto.
  const [latchedScope, setLatchedScope] = useState<LatchedPaletteScope>({
    wasOpen: open,
    scopeLabel,
    context,
  });
  if (latchedScope.wasOpen !== open) {
    setLatchedScope(
      open
        ? { wasOpen: open, scopeLabel, context }
        : { wasOpen: open, scopeLabel: latchedScope.scopeLabel, context: latchedScope.context },
    );
  }
  const capturedScopeLabel = open ? latchedScope.scopeLabel : undefined;
  const capturedContext = latchedScope.context;

  const results = useMemo(
    // Gated on `open`: a closed palette walks no command list, ranks nothing, and
    // answers from one frozen array — so the frame can re-render as often as the
    // route and the command context move without paying for a surface nobody has
    // summoned. The same array every time, so the memo below it never recomputes
    // either. Against the CAPTURED context, which is also what makes that dormancy
    // hold: the capture does not move while the route does.
    () => (open ? registry.search(query, capturedContext) : NO_RESULTS),
    // `revision` is a deliberate dependency with no use in the body: it is the
    // frame's signal that the registry's contents changed under us.
    [open, registry, query, capturedContext, revision],
  );
  const groups = useMemo(() => groupResults(results), [results]);
  const visibleCount = useMemo(
    () => (open ? registry.commandsFor(capturedContext).length : 0),
    [open, registry, capturedContext, revision],
  );

  const handleOpenChange = useCallback(
    (nextOpen: boolean): void => {
      onOpenChange(nextOpen);
    },
    [onOpenChange],
  );

  // Clear the query on close, in an EFFECT rather than inside the close handler.
  //
  // Selecting an item makes the combobox fill the input with that item's label
  // (`shouldFillInput` is true for a single-selection combobox whose input is not
  // inside a `Combobox.Popup`, which ours is not — it lives in a `Dialog.Popup`).
  // That write and a clear issued from the click handler land in the same React
  // batch, so which one survives would depend on handler-merge order inside the
  // library. An effect runs after the commit and therefore always last: the
  // palette reopens empty, never showing the id of the command last run.
  useEffect(() => {
    if (!open) {
      setQuery("");
      // The refusal goes with it. It is a fact about one press against one captured
      // reading, and the next open captures a new one — so carrying it across would
      // put a sentence about a vanished command over a list that no longer contains it.
      setInvocationRefusal(undefined);
    }
  }, [open]);

  const runResult = useCallback(
    (result: CommandSearchResult): PaletteRowPressOutcome => {
      // INVOKED FIRST, CLOSED SECOND, and the order is the fix rather than a
      // rearrangement: whether the palette should close is decided by whether the
      // command ran, and the close used to be issued before there was an answer. Both
      // land in one event handler, so React still commits them together.
      const refusal = runLatchedCommand(registry, result.command.id, capturedContext);
      if (refusal === undefined) {
        setInvocationRefusal(undefined);
        handleOpenChange(false);
        return "ran";
      }
      // The act did not happen and the rows are still on screen, which is what the
      // inline shape means. The row's own module keeps it that way — see its `onClick`.
      setInvocationRefusal(refusal);
      return "refused";
    },
    [handleOpenChange, registry, capturedContext],
  );

  // The highlighted row's own warm.
  //
  // THE HIGHLIGHT AND NOT THE HOVER, and not the query: the highlight is where a
  // person's intent is legible before they act — arrow keys move it, `autoHighlight`
  // puts it on the best match as they type, and Enter runs whatever is under it. A
  // command that opens a loader-backed body declares `preload`, and this is the moment
  // to call it: the chunk is in flight while the row is still being read.
  //
  // THE HIGHLIGHTED RESULT ARRIVES WHOLE, and that is a fact about the combobox rather
  // than a convenience. `items` is handed the GROUPS, so what the root highlights is an
  // element of a group's own `items` — a `CommandSearchResult` — and not the string a
  // `Combobox.Item` carries as its `value`. A first version of this took the id and
  // looked the result up in `results`; the lookup compared a string against an object
  // and matched nothing, so every warm was silently skipped and the boundary bought
  // nothing at the one moment it was for.
  //
  // A COMMAND WITHOUT `preload` IS THE COMMON CASE and costs one optional call.
  const warmHighlighted = useCallback((highlighted: CommandSearchResult | undefined): void => {
    highlighted?.command.preload?.();
  }, []);

  useEffect(() => {
    const parsed = parseChord(COMMAND_PALETTE_OPEN_CHORD);
    if (!parsed.ok) {
      return undefined;
    }
    const target: KeyBindingTarget = chordTarget ?? window;
    const listener = (event: Event): void => {
      if (!(event instanceof KeyboardEvent) || event.repeat || event.isComposing) {
        return;
      }
      if (!chordMatchesEvent(parsed.press, event)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      // A toggle rather than an open: pressing the same chord again is what a
      // person does to dismiss what they just summoned.
      handleOpenChange(!open);
    };
    target.addEventListener("keydown", listener, { capture: true });
    return () => {
      target.removeEventListener("keydown", listener, { capture: true });
    };
  }, [chordTarget, handleOpenChange, open]);

  const resultCountLabel =
    results.length === 1
      ? "1 command"
      : `${formatCount(results.length)} commands${results.length === PALETTE_RESULT_CAP ? " shown; refine to narrow" : ""}`;

  return (
    <Combobox.Root
      items={groups}
      open={open}
      onOpenChange={handleOpenChange}
      inline
      autoHighlight
      filter={null}
      inputValue={query}
      onInputValueChange={setQuery}
      onItemHighlighted={warmHighlighted}
    >
      <Dialog.Root open={open} onOpenChange={handleOpenChange} modal="trap-focus">
        <Dialog.Portal container={overlayContainer}>
          <Dialog.Backdrop className="console-palette__backdrop" />
          <Dialog.Popup
            className="console-palette__popup"
            initialFocus={inputRef}
            aria-label="Command palette"
          >
            {capturedScopeLabel === undefined ? null : (
              <div className="console-palette__scope">
                <span className="console-palette__scope-label">Acting on</span>
                <span className="console-palette__scope-value">{capturedScopeLabel}</span>
              </div>
            )}

            {shellBlock === undefined ? null : (
              // Above the input, because it changes what half the list will do and a
              // person needs it before they type — and rendered through the console's
              // one row-scoped refusal shape rather than a line of the palette's own.
              <div className="console-palette__degraded">
                <InlineRefusal code={shellBlock.code} detail={shellBlock.detail} />
              </div>
            )}

            <Combobox.Input
              ref={inputRef}
              className="console-palette__input"
              placeholder="Search commands"
              aria-label="Search commands"
            />

            {/*
              The CAPTURED context: the chord printed beside a row is the chord that
              would run that row, and one resolved against the live route beside a row
              resolved against the capture is two answers to one question.
            */}
            <PaletteResultList
              context={capturedContext}
              platform={platform}
              bindings={bindings}
              onRunResult={runResult}
            />

            {/*
              Must stay mounted: it announces by mutating its own text, and it is
              already a `role="status"` / `aria-live="polite"` region — which is
              why `Combobox.Status` below falls silent when the list is empty.
              Two live regions describing one absence would announce it twice.
            */}
            <Combobox.Empty className="console-palette__empty">
              <PaletteAbsence
                readiness={readiness}
                registry={registry}
                query={query}
                visibleCount={visibleCount}
              />
            </Combobox.Empty>

            <Combobox.Status className="meridian-visually-hidden">
              {results.length === 0 ? "" : resultCountLabel}
            </Combobox.Status>

            {invocationRefusal === undefined ? null : (
              // BELOW the rows rather than above the input where the read-only line
              // sits: that one is a fact about half the list and has to be read before
              // a person types, and this is the answer to the press they just made.
              <div className="console-palette__refusal">
                <InlineRefusal code={invocationRefusal.code} detail={invocationRefusal.detail} />
              </div>
            )}

            <div className="console-palette__footer">
              <span className="console-palette__footer-hints">
                <span>{formatChordForPlatform("Enter", platform)} to run</span>
                <span>{formatChordForPlatform("Escape", platform)} to close</span>
              </span>
              <span>{resultCountLabel}</span>
            </div>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </Combobox.Root>
  );
}

/**
 * What a closed palette's search answers with.
 *
 * One frozen array rather than a fresh `[]`, so the grouping memo above sees the same
 * identity every time and a closed palette recomputes literally nothing.
 */
const NO_RESULTS: readonly CommandSearchResult[] = Object.freeze([]);
