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
// nothing are `PaletteAbsence.tsx`. Every decision this surface makes — the scope
// captured at the open transition, the dormancy that makes a closed palette walk
// nothing, the clear that runs after the commit, the one chord it listens for — is
// `use-palette-overlay.ts` beside this file, because `apps/desktop/AGENTS.md`
// §State and views puts effects and derivations in a hook and never in a render
// body. This module is the composition and the markup.

import { Combobox } from "@base-ui/react/combobox";
import { Dialog } from "@base-ui/react/dialog";

import {
  InlineRefusal,
  formatChordForPlatform,
  OverlayDialogPopup,
} from "../../primitives/index.js";
import { PaletteAbsence } from "./PaletteAbsence.js";
import { PaletteResultList } from "./PaletteResultList.js";
import { usePaletteOverlay, type PaletteOverlayProps } from "./use-palette-overlay.js";

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
    open,
    platform,
    bindings,
    shellBlock,
    readiness = { status: "ready" },
    overlayContainer,
  } = props;
  const {
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
  } = usePaletteOverlay(props);

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
        {/* THE AIRSPACE REGISTRATION IS THE PRIMITIVE'S, and the whole of this
            surface's part in it is the kind it names (`Spec-023 §Console Design
            (Meridian)` 12.3, §4.3). An open palette is one of the seven overlay kinds
            a native browser-pane view has to yield to, and a view painted over it is
            the one thing 12.3 forbids outright — so the shell that mounts the popup is
            also what registers its live rectangle, and no surface can mount one
            without. */}
        <OverlayDialogPopup
          airspaceKind="command-palette"
          container={overlayContainer}
          backdropClassName="console-palette__backdrop"
          className="console-palette__popup"
          label="Command palette"
          initialFocus={inputRef}
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
        </OverlayDialogPopup>
      </Dialog.Root>
    </Combobox.Root>
  );
}
