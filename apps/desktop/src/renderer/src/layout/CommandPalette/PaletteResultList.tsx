// The palette's rows: ranked results grouped by category, and each row. It renders the
// `Combobox.List` itself because the list reads its items from the enclosing `Combobox.Root`.

import { Combobox } from "@base-ui/react/combobox";
import type { ReactNode } from "react";
import { ChordHint } from "@renderer/components/ChordHint/ChordHint.js";
import { type ChordPlatform } from "@renderer/lib/chord-format.js";
import type { CommandSearchResult } from "@renderer/registries/commands/command-ranking.js";
import type { KeybindingTable } from "@renderer/registries/keybindings/keybinding-table.js";
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
   * Supplies each row's chord; rows print none when absent. Required-but-`undefined` because
   * `exactOptionalPropertyTypes` makes it a different type from optional, and the overlay
   * forwards a value that may be undefined.
   */
  readonly bindings: KeybindingTable | undefined;
  /**
   * Runs the row's command and says whether it ran. A row that did not run must never be
   * selected, because selecting closes the combobox and a refusal must leave the palette as it was.
   */
  readonly onRunResult: (result: CommandSearchResult) => PaletteRowPressOutcome;
}

/** The listbox: one group per category, one row per ranked result. */
export function PaletteResultList(props: PaletteResultListProps): React.JSX.Element {
  const { context, platform, bindings, onRunResult } = props;

  return (
    <Combobox.List className="command-palette__list meridian-focus-inset">
      {(group: CommandResultGroup) => (
        <Combobox.Group key={group.value} items={group.items}>
          <Combobox.GroupLabel className="command-palette__group-label">
            {group.value}
          </Combobox.GroupLabel>
          <Combobox.Collection>
            {(result: CommandSearchResult) => {
              const chord = bindings?.chordFor(result.command.id, context);
              return (
                // No `index` prop: inside a group the collection's index is group-relative, while
                // `Combobox.Item.index` is flat. Passing it would collide option ids and refs
                // across groups; omitted, the item derives the flat index from DOM order.
                <Combobox.Item
                  key={result.command.id}
                  value={result.command.id}
                  className="command-palette__item"
                  // `aria-disabled`, not `disabled`: the row stays listed and reachable by arrow
                  // key so its reason can be read; the press below still refuses it.
                  aria-disabled={result.command.unavailable !== undefined}
                  onClick={(event) => {
                    // A refused row is never selected: skipping Base UI's selection keeps the
                    // palette open, and it also covers Enter on the highlighted row.
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

/** Splits a title into matched and unmatched runs; emphasis is weight and luminance, not hue. */
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
