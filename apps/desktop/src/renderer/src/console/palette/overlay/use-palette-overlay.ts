// Everything the palette DECIDES, so the component beside it only renders.
//
// `apps/desktop/AGENTS.md` §State and views: effects, subscriptions and derivations
// live in a hook and never in a render body. All four of the palette's were in one,
// and each of them is a claim worth reading on its own rather than between two JSX
// blocks: the capture that freezes the scope, the dormancy that makes a closed
// palette walk nothing, the clear that runs after the commit, and the one chord this
// surface listens for before any family has registered a command.
//
// THE HOOK TAKES THE PROPS WHOLE. The component destructures nothing before calling
// it — a hook that took eleven positional arguments would put the props' own order
// in two files, and the next optional member added would be a silent mismatch.
//
// A HOOK AND NOT A CLASS. The state here is React's: three `useState` cells, three
// memos and two effects, none of which outlives a mount or is reachable without one.
// The rule's class shape is for state a module holds, and `palette-latch.ts` beside
// this one is where the dispatch that could be held statefully already lives.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { PALETTE_RESULT_CAP } from "../../core/index.js";
import {
  COMMAND_PALETTE_OPEN_CHORD,
  formatCount,
  type ChordPlatform,
} from "../../primitives/index.js";
import type { ShellMutationBlock } from "../../store/index.js";
import type { CommandRegistry, CommandSearchResult } from "../commands/index.js";
import {
  chordMatchesEvent,
  parseChord,
  type KeyBindingTable,
  type KeyBindingTarget,
} from "../keybindings/index.js";
import type { WhenClauseContext } from "../when-clause/index.js";
import type { PaletteReadiness } from "./PaletteAbsence.js";
import { groupResults, type CommandResultGroup } from "./PaletteResultList.js";
import {
  runLatchedCommand,
  type LatchedPaletteScope,
  type PaletteInvocationRefusal,
  type PaletteRowPressOutcome,
} from "./palette-latch.js";

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

/** What the render reads. Every field is settled before the component's first JSX line. */
export interface PaletteOverlayState {
  readonly query: string;
  readonly setQuery: (query: string) => void;
  readonly groups: readonly CommandResultGroup[];
  readonly results: readonly CommandSearchResult[];
  readonly visibleCount: number;
  readonly capturedScopeLabel: string | undefined;
  readonly capturedContext: WhenClauseContext;
  readonly invocationRefusal: PaletteInvocationRefusal | undefined;
  readonly inputRef: React.RefObject<HTMLInputElement | null>;
  readonly handleOpenChange: (open: boolean) => void;
  readonly runResult: (result: CommandSearchResult) => PaletteRowPressOutcome;
  readonly warmHighlighted: (highlighted: CommandSearchResult | undefined) => void;
  readonly resultCountLabel: string;
}

export function usePaletteOverlay(props: PaletteOverlayProps): PaletteOverlayState {
  const { registry, context, open, onOpenChange, scopeLabel, revision, chordTarget } = props;

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

  return {
    query,
    setQuery,
    groups,
    results,
    visibleCount,
    capturedScopeLabel,
    capturedContext,
    invocationRefusal,
    inputRef,
    handleOpenChange,
    runResult,
    warmHighlighted,
    resultCountLabel,
  };
}

/**
 * What a closed palette's search answers with.
 *
 * One frozen array rather than a fresh `[]`, so the grouping memo above sees the same
 * identity every time and a closed palette recomputes literally nothing.
 */
const NO_RESULTS: readonly CommandSearchResult[] = Object.freeze([]);
