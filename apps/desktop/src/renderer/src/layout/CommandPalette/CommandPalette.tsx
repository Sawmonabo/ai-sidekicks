// The command palette: `Combobox.Root` in `inline` mode wrapping a `Dialog.Root`, with their
// `open` / `onOpenChange` bound together so the combobox resets its transient state on close.
// Combobox owns the roles, active descendant and keyboard navigation; Dialog owns the focus trap,
// Escape, outside press and portal.
//
// Three deviations from the library defaults:
//   - `modal="trap-focus"`: focus is trapped but the document scroll is not locked. The `inert`
//     that hides the rest of the app is the frame's, since a dialog cannot know what that is.
//   - `filter={null}`: the registry already filtered and ranked, and a second matcher would
//     diverge from the one shared with settings search.
//   - `virtualized`: every match is listed but only the rows in view are drawn, so the combobox
//     navigates by each item's `index` and the list's window scrolls a highlight into view.
//
// Rows are `PaletteResultList.tsx`, the empty state is `PaletteEmptyState.tsx`, and every
// decision (scope capture, dormancy, the post-commit clear, the open chord) is in
// `hooks/useCommandPalette.ts`.

import { Combobox } from "@base-ui/react/combobox";
import { Dialog } from "@base-ui/react/dialog";

import "./command-palette.css";

import { InlineRefusal } from "#renderer/components/Refusal/InlineRefusal.js";
import { OverlayDialogPopup } from "#renderer/components/OverlayPopups/OverlayDialogPopup.js";
import { PaletteEmptyState } from "./PaletteEmptyState.js";
import { PaletteResultList } from "./PaletteResultList.js";
import { useCommandPalette, type CommandPaletteProps } from "./hooks/useCommandPalette.js";

/**
 * The command palette, controlled on `open`: the frame decides whether it shows and the palette
 * asks for a change. The open chord has its own listener rather than riding `KeybindingTable`, so
 * it works before any feature registers a command and while a person types in the composer.
 */
export function CommandPalette(props: CommandPaletteProps): React.JSX.Element {
  const { open, onOpenChange, platform, bindings, overlayContainer } = props;
  const {
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
  } = useCommandPalette(props);

  return (
    <Combobox.Root
      items={groups}
      open={open}
      onOpenChange={onOpenChange}
      inline
      virtualized
      autoHighlight
      filter={null}
      inputValue={query}
      onInputValueChange={setQuery}
      onItemHighlighted={highlightResult}
    >
      <Dialog.Root open={open} onOpenChange={onOpenChange} modal="trap-focus">
        {/* The popup primitive registers the palette's rectangle in the window's airspace. */}
        <OverlayDialogPopup
          container={overlayContainer}
          backdropClassName="command-palette__backdrop"
          className="command-palette__popup"
          label="Command palette"
          initialFocus={inputRef}
        >
          {capturedScopeLabel === undefined ? null : (
            <div className="command-palette__scope">
              <span className="command-palette__scope-label">Acting on</span>
              <span className="command-palette__scope-value">{capturedScopeLabel}</span>
            </div>
          )}

          <Combobox.Input
            ref={inputRef}
            className="command-palette__input meridian-focus-inset"
            placeholder="Search commands"
            aria-label="Search commands"
          />

          {/* The captured context, so a printed chord is the one that would run that row. */}
          <PaletteResultList
            rows={rows}
            rowWindowRef={rowWindowRef}
            context={capturedContext}
            platform={platform}
            bindings={bindings}
            onRunResult={runResult}
          />

          {/* Must stay mounted: it is already a polite live region, and `Combobox.Status` below
              stays silent when the list is empty so one absence is not announced twice. */}
          <Combobox.Empty className="command-palette__empty">
            <PaletteEmptyState query={query} />
          </Combobox.Empty>

          <Combobox.Status className="meridian-visually-hidden">
            {results.length === 0 ? "" : resultCountLabel}
          </Combobox.Status>

          {invocationRefusal === undefined ? null : (
            // Below the rows: the answer to the press just made.
            <div className="command-palette__refusal">
              <InlineRefusal code={invocationRefusal.code} detail={invocationRefusal.detail} />
            </div>
          )}

          <div className="command-palette__footer">
            <span>Enter to run · Escape to close</span>
            <span>{resultCountLabel}</span>
          </div>
        </OverlayDialogPopup>
      </Dialog.Root>
    </Combobox.Root>
  );
}
