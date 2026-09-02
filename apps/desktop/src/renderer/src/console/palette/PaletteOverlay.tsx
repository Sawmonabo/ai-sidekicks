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
//     family. The `inert` guard on the app root is the shell's, not the palette's.
//   • `filter={null}`. The registry has already filtered and RANKED; letting the
//     combobox filter again would put a second matcher in the console, and
//     "one matcher shared with settings search" is a claim about the whole app.
//
// FIVE KINDS OF NOTHING. `Spec-023 §Console Design (Meridian)` rule 8: "A renderer
// that collapses two of these into one is wrong." The palette can be empty for
// five distinct reasons and renders five distinct things — a skeleton while
// contributions are still arriving, three different quiet lines (nothing
// registered / nothing offered here / nothing matched), a red-edged row when a
// `when` clause failed to parse and hid its command, a dotted badge when the
// frame has not evaluated its context keys, and a clock badge while something is
// still being computed. An empty query is NOT "no results".

import { Combobox } from "@base-ui/react/combobox";
import { Dialog } from "@base-ui/react/dialog";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { PALETTE_RESULT_CAP } from "../core/index.js";
import {
  ChordHint,
  formatChordForPlatform,
  formatCount,
  type ChordPlatform,
} from "../primitives/index.js";
import type { CommandRegistry, CommandSearchResult } from "./command-registry.js";
import {
  chordMatchesEvent,
  parseChord,
  type KeyBindingTable,
  type KeyBindingTarget,
} from "./keybindings.js";
import type { WhenClauseContext } from "./when-clause.js";

/**
 * The chord that opens the palette.
 *
 * `KeyK` rather than `k` so the binding is keyboard-layout independent: on an
 * AZERTY or Dvorak layout the physical key a person reaches for is the same one,
 * and matching by `KeyboardEvent.code` is what preserves that.
 */
export const COMMAND_PALETTE_OPEN_CHORD = "$mod+KeyK";

/**
 * Why the palette might have nothing to show that is not about the query.
 *
 * Supplied by the frame, because only the frame knows whether command
 * contributions have finished arriving or whether its context keys have been
 * evaluated. Defaults to `ready`, so a surface that does not care says nothing.
 */
export type PaletteReadiness =
  | { readonly status: "ready" }
  /** not loaded — contributions are still arriving. */
  | { readonly status: "loading" }
  /** unknown, still computing — a value the offer set depends on is in flight. */
  | { readonly status: "computing"; readonly detail: string }
  /** not checked — the frame has not evaluated the context keys yet. */
  | { readonly status: "unchecked"; readonly detail: string }
  /** error — the command source itself failed. Code and message render verbatim. */
  | { readonly status: "failed"; readonly code: string; readonly message: string };

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

/** Results for one category, in the order the best result in it appeared. */
interface CommandResultGroup {
  readonly value: string;
  readonly items: readonly CommandSearchResult[];
}

function groupResults(results: readonly CommandSearchResult[]): readonly CommandResultGroup[] {
  const itemsByGroup = new Map<string, CommandSearchResult[]>();
  for (const result of results) {
    const bucket = itemsByGroup.get(result.command.group);
    if (bucket === undefined) {
      itemsByGroup.set(result.command.group, [result]);
    } else {
      bucket.push(result);
    }
  }
  // Insertion order is first-appearance order, so the best-ranked category leads
  // and the categories do not reshuffle as a person types.
  return [...itemsByGroup.entries()].map(([value, items]) => ({ value, items }));
}

/**
 * Split a title into matched and unmatched runs.
 *
 * Emphasis is by weight and luminance, never hue: the two-hue rule reserves
 * colour for "a person is needed" and "something failed", and a search hit is
 * neither.
 */
function renderTitle(title: string, matchedIndices: readonly number[] | undefined): ReactNode {
  if (matchedIndices === undefined || matchedIndices.length === 0) {
    return title;
  }
  const matched = new Set(matchedIndices);
  const segments: ReactNode[] = [];
  let runStart = 0;
  let runIsMatch = matched.has(0);
  for (let characterIndex = 1; characterIndex <= title.length; characterIndex += 1) {
    const isMatch = matched.has(characterIndex);
    if (characterIndex === title.length || isMatch !== runIsMatch) {
      const text = title.slice(runStart, characterIndex);
      segments.push(
        runIsMatch ? (
          <span className="console-palette__match" key={`${String(runStart)}-match`}>
            {text}
          </span>
        ) : (
          <span key={`${String(runStart)}-plain`}>{text}</span>
        ),
      );
      runStart = characterIndex;
      runIsMatch = isMatch;
    }
  }
  return segments;
}

function AbsenceSkeleton(): React.JSX.Element {
  return (
    <div className="console-palette__absence" aria-hidden="true">
      <div className="console-palette__skeleton-row" />
      <div className="console-palette__skeleton-row" />
      <div className="console-palette__skeleton-row" />
    </div>
  );
}

interface QuietAbsenceProps {
  readonly headline: string;
  readonly detail: string;
}

function QuietAbsence(props: QuietAbsenceProps): React.JSX.Element {
  return (
    <div className="console-palette__absence">
      <span className="console-palette__absence-headline">{props.headline}</span>
      <span className="console-palette__absence-detail">{props.detail}</span>
    </div>
  );
}

/**
 * Decide which absence to render.
 *
 * The order is deliberate. A parse failure outranks every quiet absence, because
 * a hidden command with no visible cause looks exactly like a command nobody
 * contributed, and those two absences need different fixes. Readiness outranks
 * the query arms, because "still arriving" is not "nothing matched".
 */
function renderAbsence(
  readiness: PaletteReadiness,
  registry: CommandRegistry,
  query: string,
  visibleCount: number,
): ReactNode {
  if (readiness.status === "loading") {
    return <AbsenceSkeleton />;
  }

  if (readiness.status === "failed") {
    return (
      <div className="console-palette__absence console-palette__absence--error">
        <span className="console-palette__absence-headline">The command list could not load</span>
        <span className="console-palette__error-code">{readiness.code}</span>
        <span className="console-palette__absence-detail">{readiness.message}</span>
      </div>
    );
  }

  const clauseDiagnostics = registry.clauseDiagnostics();
  if (clauseDiagnostics.length > 0) {
    return (
      <div className="console-palette__absence console-palette__absence--error">
        <span className="console-palette__absence-headline">
          {formatCount(clauseDiagnostics.length)} command
          {clauseDiagnostics.length === 1 ? " is" : "s are"} hidden by a scope that did not parse
        </span>
        <ul className="console-palette__error-list">
          {clauseDiagnostics.map((diagnostic) => (
            <li key={diagnostic.commandId}>
              <span className="console-palette__error-code">{diagnostic.commandId}</span>
              {` — ${diagnostic.error.message}`}
            </li>
          ))}
        </ul>
      </div>
    );
  }

  if (readiness.status === "computing") {
    return (
      <div className="console-palette__absence">
        <span className="console-palette__badge console-palette__badge--computing">
          {"\u{1F553} Still computing"}
        </span>
        <span className="console-palette__absence-detail">{readiness.detail}</span>
      </div>
    );
  }

  if (readiness.status === "unchecked") {
    return (
      <div className="console-palette__absence">
        <span className="console-palette__badge">Not checked</span>
        <span className="console-palette__absence-detail">{readiness.detail}</span>
      </div>
    );
  }

  if (registry.size === 0) {
    return (
      <QuietAbsence
        headline="No commands are registered in this window"
        detail="An auxiliary window carries only the commands it can perform. The main window has the full set."
      />
    );
  }

  if (query.trim().length === 0 && visibleCount === 0) {
    return (
      <QuietAbsence
        headline="No commands apply here"
        detail="Every registered command is scoped to a context this window is not in. Open a session to reach the session commands."
      />
    );
  }

  return (
    <QuietAbsence
      headline={`Nothing matched "${query.trim()}"`}
      detail="Try fewer characters, or the name of the category the command sits under."
    />
  );
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

            <Combobox.List className="console-palette__list">
              {(group: CommandResultGroup) => (
                <Combobox.Group key={group.value} items={group.items}>
                  <Combobox.GroupLabel className="console-palette__group-label">
                    {group.value}
                  </Combobox.GroupLabel>
                  <Combobox.Collection>
                    {(result: CommandSearchResult) => {
                      const chord = bindings?.chordFor(result.command.id, context);
                      return (
                        // No `index` prop. `Combobox.Collection` inside a
                        // `Combobox.Group` maps over THAT GROUP's items, so the
                        // index it hands out is group-relative, while
                        // `Combobox.Item.index` is an index into the flat
                        // composite list. Passing the former would have every
                        // group's first row claim slot 0 — colliding option ids
                        // (`aria-activedescendant` breaks) and a composite list
                        // whose later groups overwrite the earlier ones' element
                        // refs. Omitted, the item derives its flat index from DOM
                        // order, which is correct by construction.
                        <Combobox.Item
                          key={result.command.id}
                          value={result.command.id}
                          className="console-palette__item"
                          onClick={() => {
                            runResult(result);
                          }}
                        >
                          <span className="console-palette__item-title">
                            {renderTitle(result.command.title, result.titleMatch?.matchedIndices)}
                          </span>
                          {result.field === "title" ? null : (
                            <span className="console-palette__item-field">
                              matched on {result.field}
                            </span>
                          )}
                          {result.recentRank === undefined ? null : (
                            <span className="console-palette__recent-mark">Recent</span>
                          )}
                          {chord === undefined ? null : (
                            <span className="console-palette__chord">
                              <ChordHint chord={chord} platform={platform} />
                            </span>
                          )}
                        </Combobox.Item>
                      );
                    }}
                  </Combobox.Collection>
                </Combobox.Group>
              )}
            </Combobox.List>

            {/*
              Must stay mounted: it announces by mutating its own text, and it is
              already a `role="status"` / `aria-live="polite"` region — which is
              why `Combobox.Status` below falls silent when the list is empty.
              Two live regions describing one absence would announce it twice.
            */}
            <Combobox.Empty className="console-palette__empty">
              {renderAbsence(readiness, registry, query, visibleCount)}
            </Combobox.Empty>

            <Combobox.Status className="console-palette__status">
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
