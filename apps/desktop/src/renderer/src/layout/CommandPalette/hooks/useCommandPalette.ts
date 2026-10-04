// The palette's state and effects, so the component only renders: the scope capture, dormancy
// while closed, the clear after the commit, and the one chord it listens for before any feature
// has registered a command. The hook takes the props whole so their order lives in one file.

import type { Combobox } from "@base-ui/react/combobox";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { COMMAND_PALETTE_OPEN_CHORD, type ChordPlatform } from "@renderer/lib/chord-format.js";
import { formatCount } from "@renderer/lib/wire-figures.js";
import type { CommandRegistry } from "@renderer/registries/commands/command-registry.js";
import type { CommandSearchResult } from "@renderer/registries/commands/command-ranking.js";
import {
  chordMatchesEvent,
  parseChord,
  type ChordParseResult,
} from "@renderer/registries/keybindings/keybinding-chord.js";
import {
  type KeybindingTable,
  type KeybindingTarget,
} from "@renderer/registries/keybindings/keybinding-table.js";
import type { WhenClauseContext } from "@renderer/registries/commands/when-clause/when-clause.js";
import {
  groupResults,
  paletteRowsFromGroups,
  type CommandResultGroup,
  type PaletteListRow,
} from "../group-results.js";
import {
  runLatchedCommand,
  type LatchedPaletteScope,
  type PaletteInvocationRefusal,
  type PaletteRowPressOutcome,
} from "../palette-latch.js";
import type { PaletteRowWindow } from "./usePaletteRowWindow.js";

/** What the mount hands the palette overlay: the registry, the live context, and the acts. */
export interface CommandPaletteProps {
  readonly registry: CommandRegistry;
  /**
   * The context keys, captured at the open transition so recomputing them on every route change
   * moves nothing under a person mid-keystroke. Drives visibility, printed chords and the run.
   */
  readonly context: WhenClauseContext;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Which chord convention to print. Passed in so a fixture can pin it. */
  readonly platform: ChordPlatform;
  /** Supplies each row's chord. Omit and rows print no chord rather than a wrong one. */
  readonly bindings?: KeybindingTable;
  /** What these commands act on. Read once at open, together with `context`, as one reading. */
  readonly scopeLabel?: string | undefined;
  /** Bump to recompute results after late registration; React cannot see a registry change. */
  readonly revision?: number;
  /** Where popups portal. The frame's overlay root; `undefined` falls back to `<body>`. */
  readonly overlayContainer?: HTMLElement | null;
  /** Listener target for the open chord. Defaults to `window`. */
  readonly chordTarget?: KeybindingTarget;
}

/** What the render reads; every field is settled before the component's first JSX line. */
export interface CommandPaletteState {
  readonly query: string;
  readonly setQuery: (query: string) => void;
  readonly groups: readonly CommandResultGroup[];
  readonly rows: readonly PaletteListRow[];
  readonly rowWindowRef: React.RefObject<PaletteRowWindow | null>;
  readonly results: readonly CommandSearchResult[];
  readonly capturedScopeLabel: string | undefined;
  readonly capturedContext: WhenClauseContext;
  readonly invocationRefusal: PaletteInvocationRefusal | undefined;
  readonly inputRef: React.RefObject<HTMLInputElement | null>;
  readonly runResult: (result: CommandSearchResult) => PaletteRowPressOutcome;
  readonly highlightResult: (
    highlighted: CommandSearchResult | undefined,
    details: Combobox.Root.HighlightEventDetails,
  ) => void;
  readonly resultCountLabel: string;
}

/** Owns the palette's state, effects and derivations; the component only renders the result. */
export function useCommandPalette(props: CommandPaletteProps): CommandPaletteState {
  const { registry, context, open, onOpenChange, scopeLabel, revision, chordTarget } = props;

  const [query, setQuery] = useState("");
  const [invocationRefusal, setInvocationRefusal] = useState<PaletteInvocationRefusal | undefined>(
    undefined,
  );
  const inputRef = useRef<HTMLInputElement | null>(null);
  const rowWindowRef = useRef<PaletteRowWindow | null>(null);

  // The label and context, latched at the open transition. Adjusted during render, not in an
  // effect, so the first frame of an open palette never shows the last open's scope. Both are
  // retained on close so the closing frame renders what the open one did.
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
    // Gated on `open`: a closed palette ranks nothing and returns one frozen array, so route
    // changes cost nothing while it is closed. Searches the captured context, which does not move.
    () => (open ? registry.search(query, capturedContext) : NO_RESULTS),
    // `revision` is a dependency with no use in the body: the signal that the registry changed.
    [open, registry, query, capturedContext, revision],
  );
  const groups = useMemo(() => groupResults(results), [results]);
  const { rows, rowIndexByItemIndex } = useMemo(() => paletteRowsFromGroups(groups), [groups]);

  // Clear the query on close, in an effect: selecting an item makes the combobox fill the input
  // with its label (single selection, input outside a `Combobox.Popup`), and a clear from the click
  // handler would race that write. An effect runs after the commit, so the palette reopens empty.
  useEffect(() => {
    if (!open) {
      setQuery("");
      // The refusal is about one press against one captured reading, so it does not carry over.
      setInvocationRefusal(undefined);
    }
  }, [open]);

  const runResult = useCallback(
    (result: CommandSearchResult): PaletteRowPressOutcome => {
      // Invoke first, close second: whether to close depends on whether the command ran.
      const refusal = runLatchedCommand(registry, result.command.id, capturedContext);
      if (refusal === undefined) {
        setInvocationRefusal(undefined);
        onOpenChange(false);
        return "ran";
      }
      // The rows stay on screen (see the row's `onClick`), so the refusal shows inline.
      setInvocationRefusal(refusal);
      return "refused";
    },
    [onOpenChange, registry, capturedContext],
  );

  // Warm the highlighted row, not the hover: the highlight is where intent is legible before the
  // act. The root highlights a `CommandSearchResult` (an element of a group's `items`), not the
  // string `Combobox.Item` carries as its `value`. `preload` is optional; most commands lack it.
  const highlightResult = useCallback(
    (
      highlighted: CommandSearchResult | undefined,
      details: Combobox.Root.HighlightEventDetails,
    ): void => {
      if (highlighted === undefined) {
        return;
      }
      highlighted.command.preload?.();
      // A pointer highlight is already on screen. A keyboard or query highlight may sit outside
      // the window, where no row is drawn for the combobox to scroll to, so the window scrolls.
      if (details.reason === "pointer") {
        return;
      }
      // The first match scrolls to the top so its category heading shows too.
      const rowIndex = details.index === 0 ? 0 : rowIndexByItemIndex[details.index];
      if (rowIndex === undefined) {
        return;
      }
      // After the commit: a query highlight arrives before the window has taken the new rows.
      queueMicrotask(() => {
        rowWindowRef.current?.scrollToIndex(rowIndex, { align: "auto" });
      });
    },
    [rowIndexByItemIndex],
  );

  useEffect(() => {
    const target: KeybindingTarget = chordTarget ?? window;
    const listener = (event: Event): void => {
      if (!(event instanceof KeyboardEvent) || event.repeat || event.isComposing) {
        return;
      }
      if (!chordMatchesEvent(OPEN_CHORD.press, event)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      // A toggle: pressing the chord again dismisses what it summoned.
      onOpenChange(!open);
    };
    target.addEventListener("keydown", listener, { capture: true });
    return () => {
      target.removeEventListener("keydown", listener, { capture: true });
    };
  }, [chordTarget, onOpenChange, open]);

  const resultCountLabel =
    results.length === 1 ? "1 command" : `${formatCount(results.length)} commands`;

  return {
    query,
    setQuery,
    groups,
    rows,
    rowWindowRef,
    results,
    capturedScopeLabel,
    capturedContext,
    invocationRefusal,
    inputRef,
    runResult,
    highlightResult,
    resultCountLabel,
  };
}

/** What a closed palette's search returns: one frozen array, so the grouping memo never reruns. */
const NO_RESULTS: readonly CommandSearchResult[] = Object.freeze([]);

/** The open chord, parsed once at load; a constant chord that fails to parse is a build defect. */
const OPEN_CHORD: Extract<ChordParseResult, { readonly ok: true }> = parsedOpenChord();

function parsedOpenChord(): Extract<ChordParseResult, { readonly ok: true }> {
  const parsed = parseChord(COMMAND_PALETTE_OPEN_CHORD);
  if (!parsed.ok) {
    throw new Error(parsed.message);
  }
  return parsed;
}
