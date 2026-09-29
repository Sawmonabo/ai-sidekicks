// The palette's rows — how ranked results become categories, and each row.
//
// Split from `CommandPalette.tsx` because the overlay composes (combobox +
// dialog + the open chord) and this renders (a group, a title with its matched
// runs, the provenance mark, the chord). Both halves stay inside one
// `Combobox.Root`: `Combobox.List` reads the items from that root's context, so
// this component renders the list element itself rather than taking the groups as
// a prop — the grouping function that feeds the root is `group-results.ts` beside it.

import { Combobox } from "@base-ui/react/combobox";
import type { ReactNode } from "react";
import { ChordHint, type ChordPlatform } from "@renderer/console/primitives/index.js";
import type { CommandSearchResult } from "@renderer/registries/commands/command-ranking.js";
import type { KeyBindingTable } from "@renderer/registries/keybindings/keybinding-table.js";
import type { PaletteRowPressOutcome } from "./palette-latch.js";
import type { CommandResultGroup } from "./group-results.js";
import type { WhenClauseContext } from "@renderer/registries/commands/when-clause/when-clause.js";

/** What the palette's listbox renders its rows against. */
export interface PaletteResultListProps {
  /** The live context keys. Decides which chord is printed beside a row. */
  readonly context: WhenClauseContext;
  /** Which chord convention to print. Passed in so a fixture can pin it. */
  readonly platform: ChordPlatform;
  /**
   * Supplies each row's chord. Rows print no chord rather than a wrong one when
   * it is absent. Required-but-`undefined` rather than optional, because
   * `exactOptionalPropertyTypes` makes those two different types and the overlay
   * forwards a value that may genuinely be undefined.
   */
  readonly bindings: KeyBindingTable | undefined;
  /**
   * Run the row's command, and say whether it ran.
   *
   * The answer is load-bearing rather than informational: selecting an item is what
   * closes the combobox, and a command that refused must leave the palette exactly as
   * it was — so a row that did not run is never selected. See the call site below.
   */
  readonly onRunResult: (result: CommandSearchResult) => PaletteRowPressOutcome;
}

/** The listbox: one group per category, one row per ranked result. */
export function PaletteResultList(props: PaletteResultListProps): React.JSX.Element {
  const { context, platform, bindings, onRunResult } = props;

  return (
    <Combobox.List className="command-palette__list">
      {(group: CommandResultGroup) => (
        <Combobox.Group key={group.value} items={group.items}>
          <Combobox.GroupLabel className="command-palette__group-label">
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
                  className="command-palette__item"
                  // `aria-disabled` and not `disabled`: the row stays listed, stays
                  // reachable by arrow key, and stays readable, because its reason is
                  // the thing a person came here to find out. The press below still
                  // refuses it, so the closed state is enforced by the registry rather
                  // than by the attribute.
                  aria-disabled={result.command.unavailable !== undefined}
                  onClick={(event) => {
                    // A REFUSED ROW IS NEVER SELECTED, and `preventBaseUIHandler` is
                    // the library's own way to say so: merged handlers run ours first,
                    // and this one skips Base UI's selection for this event. Selection
                    // is what asks the combobox to close, so without it a refusal would
                    // flash and the palette would dismiss itself — reporting a command
                    // that never ran exactly as it reports one that did. This also
                    // fires for Enter on the highlighted row, which is the same act by
                    // the other input.
                    if (onRunResult(result) === "refused") {
                      event.preventBaseUIHandler();
                    }
                  }}
                >
                  <span className="command-palette__item-title">
                    {renderTitle(result.command.title, result.titleMatch?.matchedIndices)}
                  </span>
                  {result.command.unavailable === undefined ? null : (
                    <span className="command-palette__item-unavailable">
                      {result.command.unavailable}
                    </span>
                  )}
                  {result.recentRank === undefined ? null : (
                    <span className="command-palette__recent-mark">Recent</span>
                  )}
                  {chord === undefined ? null : (
                    <span className="command-palette__chord">
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
  );
}

/**
 * Split a title into matched and unmatched runs.
 *
 * Emphasis is by weight and luminance, never hue: the two-hue rule reserves
 * color for "a person is needed" and "something failed", and a search hit is
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
          <span className="command-palette__match" key={`${String(runStart)}-match`}>
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
