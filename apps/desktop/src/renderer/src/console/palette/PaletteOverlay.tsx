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
// WHAT IS NOT HERE. The rows are `PaletteResultList.tsx` and the five kinds of
// nothing are `PaletteAbsence.tsx`. This module is the composition, the query
// state, and the one chord that opens the whole thing.

import { Combobox } from "@base-ui/react/combobox";
import { Dialog } from "@base-ui/react/dialog";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PALETTE_RESULT_CAP } from "../core/index.js";
import {
  COMMAND_PALETTE_OPEN_CHORD,
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
import type { WhenClauseContext } from "./when-clause.js";

export interface PaletteOverlayProps {
  readonly registry: CommandRegistry;
  /** The live context keys. Drives both visibility and which chord is printed. */
  readonly context: WhenClauseContext;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Which chord convention to print. Passed in so a fixture can pin it. */
  readonly platform: ChordPlatform;
  /** Supplies each row's chord. Omit and rows print no chord rather than a wrong one. */
  readonly bindings?: KeyBindingTable;
  /** The scoped-context row: what these commands act on. */
  readonly scopeLabel?: string;
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
    readiness = { status: "ready" },
    revision,
    overlayContainer,
    chordTarget,
  } = props;

  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  const results = useMemo(
    () => registry.search(query, context),
    // `revision` is a deliberate dependency with no use in the body: it is the
    // frame's signal that the registry's contents changed under us.
    [registry, query, context, revision],
  );
  const groups = useMemo(() => groupResults(results), [results]);
  const visibleCount = useMemo(
    () => registry.commandsFor(context).length,
    [registry, context, revision],
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
    }
  }, [open]);

  const runResult = useCallback(
    (result: CommandSearchResult): void => {
      handleOpenChange(false);
      // Fire-and-forget by design: the registry hands back the command's own
      // promise and the palette must not hold the dialog open waiting on a
      // command that opens another surface. A rejection is the command's to
      // report on its own surface, so it is not swallowed here silently — it
      // simply is not the palette's to render.
      registry.invoke(result.command.id, context);
    },
    [handleOpenChange, registry, context],
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
            {scopeLabel === undefined ? null : (
              <div className="console-palette__scope">
                <span className="console-palette__scope-label">Acting on</span>
                <span className="console-palette__scope-value">{scopeLabel}</span>
              </div>
            )}

            <Combobox.Input
              ref={inputRef}
              className="console-palette__input"
              placeholder="Search commands"
              aria-label="Search commands"
            />

            <PaletteResultList
              context={context}
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
