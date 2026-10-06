// How a query becomes ranked rows. `scoreSubsequence` is the matcher shared with settings
// search; this module is the policy above it: field weights, recency, and the total order.
// It is a pure function of a command list, a query and a recents list.

import { compareCodeUnits } from "#renderer/lib/compare-code-units.js";
import type { CommandDefinition } from "./definition.js";
import { scoreSubsequence, type SubsequenceMatch } from "@ai-sidekicks/search-ranking";

/** One ranked palette row. */
export interface CommandSearchResult {
  readonly command: CommandDefinition;
  /** Higher is better. Comparable only within one `search` call. */
  readonly score: number;
  /** Positions in `command.title` to emphasize; `undefined` when the match was not on the title. */
  readonly titleMatch: SubsequenceMatch | undefined;
  /** 0 = most recently invoked. `undefined` when the command is not in recents. */
  readonly recentRank: number | undefined;
}

/** The best field a command matched a query on, with its score. */
export interface CommandFieldMatch {
  readonly score: number;
  readonly titleMatch: SubsequenceMatch | undefined;
}

/**
 * Subtracted from a keyword match. Subtracted, not multiplied: a scattered title match can
 * score below zero, and scaling a negative by a fraction raises it above the title hit.
 */
export const COMMAND_KEYWORD_FIELD_PENALTY = 40;

/** Subtracted from a group-name match, the weakest field. */
export const COMMAND_GROUP_FIELD_PENALTY = 64;

/**
 * Added to a recent command's score, decaying by one per position. Small so recency only
 * breaks ties between comparable matches and never lifts a poor match over a good one.
 */
export const COMMAND_RECENCY_BONUS = 12;

/**
 * Display order for two commands: category, then title, then id. Ends at the unique `id`, so
 * the order is total and two renders of one command set are identical.
 */
export function compareCommandsForDisplay(
  left: CommandDefinition,
  right: CommandDefinition,
): number {
  return (
    compareCodeUnits(left.group, right.group) ||
    compareCodeUnits(left.title, right.title) ||
    compareCodeUnits(left.id, right.id)
  );
}

/**
 * The best of a command's title, keywords and group against a query, or `undefined` when none
 * matched. Field penalties are already applied.
 */
export function scoreCommandAgainstQuery(
  command: CommandDefinition,
  query: string,
): CommandFieldMatch | undefined {
  const titleMatch = scoreSubsequence(command.title, query);
  let best: CommandFieldMatch | undefined =
    titleMatch === undefined ? undefined : { score: titleMatch.score, titleMatch };

  for (const keyword of command.keywords ?? []) {
    const keywordMatch = scoreSubsequence(keyword, query);
    if (keywordMatch === undefined) {
      continue;
    }
    const score = keywordMatch.score - COMMAND_KEYWORD_FIELD_PENALTY;
    if (best === undefined || score > best.score) {
      best = { score, titleMatch: undefined };
    }
  }

  const groupMatch = scoreSubsequence(command.group, query);
  if (groupMatch !== undefined) {
    const score = groupMatch.score - COMMAND_GROUP_FIELD_PENALTY;
    if (best === undefined || score > best.score) {
      best = { score, titleMatch: undefined };
    }
  }

  return best;
}

/** Orders results by score, then recency, then display order, so the order is total. */
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
 * Ranks an already-visible command list against a non-empty query. The caller has applied
 * `when` filtering, so this decides rank only, never what is offered.
 */
export function rankCommandsForQuery(
  visibleCommands: readonly CommandDefinition[],
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
      titleMatch: scored.titleMatch,
      recentRank,
    });
  }

  results.sort(compareCommandSearchResults);
  return results;
}

/**
 * The rows for an empty query: recents first, then the rest in category order. An empty
 * query is its own state, not a query that matches everything.
 */
export function rankCommandsForEmptyQuery(
  visibleCommands: readonly CommandDefinition[],
  recentRankById: ReadonlyMap<string, number>,
): readonly CommandSearchResult[] {
  const recentResults: CommandSearchResult[] = [];
  const remainingResults: CommandSearchResult[] = [];
  for (const command of visibleCommands) {
    const recentRank = recentRankById.get(command.id);
    const result: CommandSearchResult = {
      command,
      score: 0,
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
  // `visibleCommands` already arrives in display order; the remainder must not be re-sorted.
  return [...recentResults, ...remainingResults];
}
