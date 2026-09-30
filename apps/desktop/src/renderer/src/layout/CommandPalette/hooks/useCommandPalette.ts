// The palette's state and effects, so the component only renders: the scope capture, dormancy
// while closed, the clear after the commit, and the one chord it listens for before any feature
// has registered a command. The hook takes the props whole so their order lives in one file.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { COMMAND_PALETTE_RESULT_CAP } from "@renderer/registries/commands/command-palette-caps.js";
import { COMMAND_PALETTE_OPEN_CHORD, type ChordPlatform } from "@renderer/lib/chord-format.js";
import { formatCount } from "@renderer/lib/wire-figures.js";
import type { CommandRegistry } from "@renderer/registries/commands/command-registry.js";
import type { CommandSearchResult } from "@renderer/registries/commands/command-ranking.js";
import {
  chordMatchesEvent,
  parseChord,
} from "@renderer/registries/keybindings/keybinding-chord.js";
import {
  type KeybindingTable,
  type KeybindingTarget,
} from "@renderer/registries/keybindings/keybinding-table.js";
import type { WhenClauseContext } from "@renderer/registries/commands/when-clause/when-clause.js";
import type { PaletteReadiness } from "../PaletteEmptyState.js";
import { groupResults, type CommandResultGroup } from "../group-results.js";
import {
  runLatchedCommand,
  type LatchedPaletteScope,
  type PaletteInvocationRefusal,
  type PaletteRowPressOutcome,
} from "../palette-latch.js";

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
  readonly scopeLabel?: string;
  readonly readiness?: PaletteReadiness;
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

/** Owns the palette's state, effects and derivations; the component only renders the result. */
export function useCommandPalette(props: CommandPaletteProps): CommandPaletteState {
  const { registry, context, open, onOpenChange, scopeLabel, revision, chordTarget } = props;

  const [query, setQuery] = useState("");
  const [invocationRefusal, setInvocationRefusal] = useState<PaletteInvocationRefusal | undefined>(
    undefined,
  );
  const inputRef = useRef<HTMLInputElement | null>(null);

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
        handleOpenChange(false);
        return "ran";
      }
      // The rows stay on screen (see the row's `onClick`), so the refusal shows inline.
      setInvocationRefusal(refusal);
      return "refused";
    },
    [handleOpenChange, registry, capturedContext],
  );

  // Warm the highlighted row, not the hover: the highlight is where intent is legible before the
  // act. The root highlights a `CommandSearchResult` (an element of a group's `items`), not the
  // string `Combobox.Item` carries as its `value`. `preload` is optional; most commands lack it.
  const warmHighlighted = useCallback((highlighted: CommandSearchResult | undefined): void => {
    highlighted?.command.preload?.();
  }, []);

  useEffect(() => {
    const parsed = parseChord(COMMAND_PALETTE_OPEN_CHORD);
    if (!parsed.ok) {
      return undefined;
    }
    const target: KeybindingTarget = chordTarget ?? window;
    const listener = (event: Event): void => {
      if (!(event instanceof KeyboardEvent) || event.repeat || event.isComposing) {
        return;
      }
      if (!chordMatchesEvent(parsed.press, event)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      // A toggle: pressing the chord again dismisses what it summoned.
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
      : `${formatCount(results.length)} commands${results.length === COMMAND_PALETTE_RESULT_CAP ? " shown; refine to narrow" : ""}`;

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

/** What a closed palette's search returns: one frozen array, so the grouping memo never reruns. */
const NO_RESULTS: readonly CommandSearchResult[] = Object.freeze([]);
