// What the one box above the page list finds, and in what order.
//
// Every typed word has to appear in a control's label, the heading it sits under or its hint, as
// `scoreSubsequence` judges it, the matcher the command palette ranks with, so a word finds the
// same text in both places. A page is found the same way in its name or the words it declares. A
// hit ranks by the weakest field any of its words needed (label, then heading, then hint; a
// page's name counts as a label and its words as a hint), equal ranks fall in page order, and a
// page sits ahead of its own controls at an equal rank.

import { scoreSubsequence } from "@ai-sidekicks/search-ranking";

import { SETTINGS_PAGE_LABELS } from "./pages/labels.js";
import type { SettingsPageDescriptor } from "./pages/registry.js";
import type { SettingsPageId } from "#renderer/routing/settings-page-ids.js";

/** One search hit: what it reads, and the page and control it opens. */
export interface SettingsSearchHit {
  readonly pageId: SettingsPageId;
  /** The control a press lands on; `undefined` for a hit on the page itself. */
  readonly controlId: string | undefined;
  readonly label: string;
  /**
   * Where a control sits, read under its label: `Page › Heading`, or the page alone under no
   * heading. `undefined` for a page, whose label is its name.
   */
  readonly place: string | undefined;
}

/**
 * Every page and control the query finds, best rank first and in page order within a rank.
 *
 * Words are the query split on white space; a blank query finds nothing, since the list, not a
 * search, is what a person reads then.
 */
export function findSettings(
  pages: readonly SettingsPageDescriptor[],
  query: string,
): readonly SettingsSearchHit[] {
  const words = query
    .trim()
    .split(/\s+/u)
    .filter((word) => word !== "");
  if (words.length === 0) {
    return [];
  }
  const ranked: RankedHit[] = [];
  for (const page of pages) {
    const pageLabel = SETTINGS_PAGE_LABELS[page.pageId];
    const pageRank = rankOf(words, { label: [pageLabel], heading: [], hint: page.keywords });
    if (pageRank !== undefined) {
      ranked.push({
        rank: pageRank,
        hit: { pageId: page.pageId, controlId: undefined, label: pageLabel, place: undefined },
      });
    }
    for (const control of page.controls) {
      const controlRank = rankOf(words, {
        label: [control.label],
        heading: control.heading === undefined ? [] : [control.heading],
        hint: control.hint === undefined ? [] : [control.hint],
      });
      if (controlRank !== undefined) {
        ranked.push({
          rank: controlRank,
          hit: {
            pageId: page.pageId,
            controlId: control.id,
            label: control.label,
            place: control.heading === undefined ? pageLabel : `${pageLabel} › ${control.heading}`,
          },
        });
      }
    }
  }
  // `Array.prototype.sort` is stable, so hits of one rank keep the page order they were found in.
  return ranked.sort((left, right) => left.rank - right.rank).map((entry) => entry.hit);
}

/** The fields a word may appear in, strongest first; a hit's rank is the weakest one it used. */
const SEARCH_FIELDS = ["label", "heading", "hint"] as const;

type SearchField = (typeof SEARCH_FIELDS)[number];

/** A hit and the rank it was found at. */
interface RankedHit {
  readonly rank: number;
  readonly hit: SettingsSearchHit;
}

/** The weakest field any word needed, or `undefined` when a word appears in none of them. */
function rankOf(
  words: readonly string[],
  fieldTexts: Readonly<Record<SearchField, readonly string[]>>,
): number | undefined {
  let rank = 0;
  for (const word of words) {
    const wordRank = SEARCH_FIELDS.findIndex((field) =>
      fieldTexts[field].some((text) => scoreSubsequence(text, word) !== undefined),
    );
    if (wordRank === -1) {
      return undefined;
    }
    rank = Math.max(rank, wordRank);
  }
  return rank;
}
