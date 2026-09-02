// The ranking — how a query becomes rows, and what order rows come back in.
//
// `Spec-023 §Console Design (Meridian)` §Layout grammar names "one matcher shared
// with settings search". `scoreSubsequence` is that matcher, imported rather than
// re-implemented; this module is the POLICY above it — which of a command's three
// text fields a hit is worth most on, what recency is worth, and the total order
// two results are put in. It is separated from `command-registry.ts` because the
// registry is a store with an identity rule and this is a pure function of a
// command list, a query, and a recents list: no state, nothing to own.
//
// The `ConsoleCommand` type ranked here is declared in `command-registry.ts`, the
// module that holds one. The import below is type-only and erased, so the runtime
// edge runs one way: the registry reaches down here, and nothing here reaches
// back.

import { PALETTE_RESULT_CAP } from "../core/index.js";
import type { ConsoleCommand } from "./contributions.js";
import { scoreSubsequence, type SubsequenceMatch } from "./subsequence-score.js";

/** Which text of a command a result matched on. Rendered as provenance, not just rank. */
export type CommandMatchField = "title" | "keyword" | "group";

/** One ranked row. */
export interface CommandSearchResult {
  readonly command: ConsoleCommand;
  /** Higher is better. Comparable only within one `search` call. */
  readonly score: number;
  readonly field: CommandMatchField;
  /**
   * Character positions in `command.title` to emphasise, when the match was on the
   * title. Deliberately a required member typed `| undefined` rather than an
   * optional one: `exactOptionalPropertyTypes` makes those two different types,
   * and a required-but-absent value is the honest shape for "there is no title
   * match to emphasise".
   */
  readonly titleMatch: SubsequenceMatch | undefined;
  /** 0 = most recently invoked. `undefined` when the command is not in recents. */
  readonly recentRank: number | undefined;
}

/** The best field a command matched a query on, with what that match is worth. */
export interface CommandFieldMatch {
  readonly score: number;
  readonly field: CommandMatchField;
  readonly titleMatch: SubsequenceMatch | undefined;
}

/**
 * Subtracted from a match on a field other than the title.
 *
 * ADDITIVE, never multiplicative. A multiplier looks equivalent and is not: a
 * scattered title match can score below zero, and multiplying a negative by a
 * fraction makes it LARGER — a keyword hit would then outrank the title hit it
 * was supposed to sit under. Subtraction is monotone at every score.
 */
export const COMMAND_KEYWORD_FIELD_PENALTY = 40;

/** As above, for the weakest field. A group name is context, not the act's name. */
export const COMMAND_GROUP_FIELD_PENALTY = 64;

/**
 * Added to a recently invoked command's score, decaying by one per position.
 *
 * Small on purpose: recency breaks ties between comparable matches and must never
 * float a poor match over a good one, because a palette that answers with the
 * last thing you ran rather than the thing you typed stops being a search.
 */
export const COMMAND_RECENCY_BONUS = 12;

function compareStrings(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

/**
 * The console's display order for two commands: category, then title, then id.
 *
 * The chain ends at `id`, which is unique, so the order is TOTAL — two renders of
 * one command set are byte-identical, which is what the screenshot tier depends
 * on. One function rather than the same three-term chain written at each call
 * site, because an unranked list and the tail of a ranked one that disagreed
 * about category order would reshuffle the palette between an empty query and a
 * cleared one.
 */
export function compareCommandsForDisplay(left: ConsoleCommand, right: ConsoleCommand): number {
  return (
    compareStrings(left.group, right.group) ||
    compareStrings(left.title, right.title) ||
    compareStrings(left.id, right.id)
  );
}

/**
 * The best of a command's three fields against a query, or `undefined` when none
 * of them matched. Field penalties are applied here, so a caller adding a bonus
 * is adding it to a figure the fields are already comparable on.
 */
export function scoreCommandAgainstQuery(
  command: ConsoleCommand,
  query: string,
): CommandFieldMatch | undefined {
  const titleMatch = scoreSubsequence(command.title, query);
  let best: CommandFieldMatch | undefined =
    titleMatch === undefined ? undefined : { score: titleMatch.score, field: "title", titleMatch };

  for (const keyword of command.keywords ?? []) {
    const keywordMatch = scoreSubsequence(keyword, query);
    if (keywordMatch === undefined) {
      continue;
    }
    const score = keywordMatch.score - COMMAND_KEYWORD_FIELD_PENALTY;
    if (best === undefined || score > best.score) {
      best = { score, field: "keyword", titleMatch: undefined };
    }
  }

  const groupMatch = scoreSubsequence(command.group, query);
  if (groupMatch !== undefined) {
    const score = groupMatch.score - COMMAND_GROUP_FIELD_PENALTY;
    if (best === undefined || score > best.score) {
      best = { score, field: "group", titleMatch: undefined };
    }
  }

  return best;
}

/**
 * Score first, then a chain of stable keys ending in the display order, which is
 * itself total. Two renders of one result set are therefore byte-identical.
 */
export function compareCommandSearchResults(
  left: CommandSearchResult,
  right: CommandSearchResult,
): number {
  if (left.score !== right.score) {
    return right.score - left.score;
  }
  const leftRecency = left.recentRank ?? Number.MAX_SAFE_INTEGER;
  const rightRecency = right.recentRank ?? Number.MAX_SAFE_INTEGER;
  if (leftRecency !== rightRecency) {
    return leftRecency - rightRecency;
  }
  return compareCommandsForDisplay(left.command, right.command);
}

/**
 * Rank an already-visible command list against a non-empty query.
 *
 * `visibleCommands` has been filtered by the caller's `when` evaluation, so this
 * function decides rank only — it never decides what is offered.
 */
export function rankCommandsForQuery(
  visibleCommands: readonly ConsoleCommand[],
  query: string,
  recentRankById: ReadonlyMap<string, number>,
): readonly CommandSearchResult[] {
  const results: CommandSearchResult[] = [];
  for (const command of visibleCommands) {
    const scored = scoreCommandAgainstQuery(command, query);
    if (scored === undefined) {
      continue;
    }
    const recentRank = recentRankById.get(command.id);
    const recencyBonus =
      recentRank === undefined ? 0 : Math.max(0, COMMAND_RECENCY_BONUS - recentRank);
    results.push({
      command,
      score: scored.score + recencyBonus,
      field: scored.field,
      titleMatch: scored.titleMatch,
      recentRank,
    });
  }

  results.sort(compareCommandSearchResults);
  return results.slice(0, PALETTE_RESULT_CAP);
}

/**
 * The rows for an EMPTY query — recents first, then the rest in category order.
 *
 * An empty query is a different state, not a query that matches everything, which
 * is why it has its own function rather than a special case inside the scorer.
 */
export function rankCommandsForEmptyQuery(
  visibleCommands: readonly ConsoleCommand[],
  recentRankById: ReadonlyMap<string, number>,
): readonly CommandSearchResult[] {
  const recentResults: CommandSearchResult[] = [];
  const remainingResults: CommandSearchResult[] = [];
  for (const command of visibleCommands) {
    const recentRank = recentRankById.get(command.id);
    const result: CommandSearchResult = {
      command,
      score: 0,
      field: "title",
      titleMatch: undefined,
      recentRank,
    };
    if (recentRank === undefined) {
      remainingResults.push(result);
    } else {
      recentResults.push(result);
    }
  }
  recentResults.sort((left, right) => (left.recentRank ?? 0) - (right.recentRank ?? 0));
  // `visibleCommands` already arrives in group-then-title order, so the
  // remainder needs no second sort — and must not get one, or the categories
  // would reshuffle between an empty query and a cleared query.
  return [...recentResults, ...remainingResults].slice(0, PALETTE_RESULT_CAP);
}
