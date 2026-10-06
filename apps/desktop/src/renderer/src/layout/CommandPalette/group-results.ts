// How ranked results become the palette's categories, and the categories its windowed list rows.

import type { CommandSearchResult } from "#renderer/registries/commands/ranking.js";

/** Results for one category, in the order the best result in it appeared. */
export interface CommandResultGroup {
  readonly value: string;
  readonly items: readonly CommandSearchResult[];
}

/** One row of the windowed list: a category's heading, or one command under it. */
export type PaletteListRow =
  | { readonly kind: "group-label"; readonly group: string }
  | {
      readonly kind: "command";
      readonly group: string;
      readonly result: CommandSearchResult;
      /** The combobox's flat item index: counts commands across categories, skips headings. */
      readonly itemIndex: number;
      /** Counted from zero within the category. */
      readonly positionInGroup: number;
      readonly groupSize: number;
    };

/** The list's rows, and the row each combobox item sits on, so a highlight can be scrolled to. */
export interface PaletteListRows {
  readonly rows: readonly PaletteListRow[];
  readonly rowIndexByItemIndex: readonly number[];
}

/**
 * Groups ranked results by category in first-appearance order, so the best-ranked category leads
 * and categories do not reshuffle as a person types.
 */
export function groupResults(
  results: readonly CommandSearchResult[],
): readonly CommandResultGroup[] {
  const itemsByGroup = new Map<string, CommandSearchResult[]>();
  for (const result of results) {
    const bucket = itemsByGroup.get(result.command.group);
    if (bucket === undefined) {
      itemsByGroup.set(result.command.group, [result]);
    } else {
      bucket.push(result);
    }
  }
  return [...itemsByGroup.entries()].map(([value, items]) => ({ value, items }));
}

/**
 * Flattens the categories into one row list, each heading before its commands. Item indices
 * follow the same order the combobox flattens its grouped `items` in, so the two agree.
 */
export function paletteRowsFromGroups(groups: readonly CommandResultGroup[]): PaletteListRows {
  const rows: PaletteListRow[] = [];
  const rowIndexByItemIndex: number[] = [];
  for (const group of groups) {
    rows.push({ kind: "group-label", group: group.value });
    group.items.forEach((result, positionInGroup) => {
      rowIndexByItemIndex.push(rows.length);
      rows.push({
        kind: "command",
        group: group.value,
        result,
        itemIndex: rowIndexByItemIndex.length - 1,
        positionInGroup,
        groupSize: group.items.length,
      });
    });
  }
  return { rows, rowIndexByItemIndex };
}
