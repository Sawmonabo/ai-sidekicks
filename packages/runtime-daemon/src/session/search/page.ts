// One `session.search` page from sessions offered in order: whole sessions while their hits fit
// the page's hit limit and one message, and where the next page starts. A session whose hits
// alone overflow a page fills the page by itself and the next page continues it.

import { jsonUtf8ByteLength } from "@ai-sidekicks/contracts/jsonrpc/message";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import type { SessionSearchGroup, SessionSearchHit } from "@ai-sidekicks/contracts/session/methods";
import { PAGE_MAX_BYTES, countEntriesFittingOneFrame } from "@ai-sidekicks/contracts/jsonrpc/page";

import type { SearchPagePosition } from "./cursor.js";

/** A session offered to a page: its hits no earlier page showed, best first. */
export interface PageCandidate<Hit> {
  readonly sessionId: SessionId;
  readonly name: string | null;
  readonly hits: readonly Hit[];
  /** The position of a page that starts at this session with `shownHitCount` of its hits shown. */
  readonly positionAt: (shownHitCount: number) => SearchPagePosition;
}

/** One page's groups, and where the next page starts while hits remain; then at least one group. */
export type SearchPage =
  | {
      readonly groups: [SessionSearchGroup, ...SessionSearchGroup[]];
      readonly next: SearchPagePosition;
    }
  | { readonly groups: SessionSearchGroup[]; readonly next: undefined };

interface Selection<Hit> {
  readonly candidate: PageCandidate<Hit>;
  readonly hits: readonly Hit[];
}

/**
 * Builds a page from `candidates` in order, at most `limit` hits. `showHits` turns the chosen hits
 * into what the page carries, in order, once for the whole page. The candidates are read only up
 * to the first session that does not fit, which is where the next page starts.
 */
export function assembleSearchPage<Hit>(
  candidates: Iterable<PageCandidate<Hit>>,
  limit: number,
  showHits: (hits: readonly Hit[]) => SessionSearchHit[],
): SearchPage {
  const selections: Selection<Hit>[] = [];
  let room = limit;
  let next: SearchPagePosition | undefined;
  for (const candidate of candidates) {
    const { hits } = candidate;
    if (hits.length === 0) {
      continue;
    }
    if (hits.length <= room) {
      selections.push({ candidate, hits });
      room -= hits.length;
      continue;
    }
    if (selections.length === 0) {
      selections.push({ candidate, hits: hits.slice(0, room) });
      next = candidate.positionAt(room);
    } else {
      next = candidate.positionAt(0);
    }
    break;
  }
  const shownHits = showHits(selections.flatMap((selection) => selection.hits));
  let offset = 0;
  const groups = selections.map((selection): SessionSearchGroup => {
    const { sessionId, name } = selection.candidate;
    const hits = shownHits.slice(offset, offset + selection.hits.length);
    offset += selection.hits.length;
    return name === null ? { sessionId, hits } : { sessionId, name, hits };
  });
  return fitOneMessage(selections, groups, next);
}

// Cuts the page to what one message carries: whole groups while they fit, or, when the first group
// alone is over, as many of its hits as fit.
function fitOneMessage<Hit>(
  selections: readonly Selection<Hit>[],
  groups: SessionSearchGroup[],
  next: SearchPagePosition | undefined,
): SearchPage {
  const [firstGroup, ...otherGroups] = groups;
  const [firstSelection] = selections;
  if (firstGroup === undefined || firstSelection === undefined) {
    return { groups: [], next: undefined };
  }
  const { candidate } = firstSelection;
  if (jsonUtf8ByteLength([firstGroup]) > PAGE_MAX_BYTES) {
    const hitCount = countHitsFittingOneGroup(firstGroup);
    return {
      groups: [{ ...firstGroup, hits: firstGroup.hits.slice(0, hitCount) }],
      next: candidate.positionAt(hitCount),
    };
  }
  const groupCount = countEntriesFittingOneFrame(groups, groups.length);
  const firstLeftOut = selections[groupCount];
  const keptGroups: [SessionSearchGroup, ...SessionSearchGroup[]] = [
    firstGroup,
    ...otherGroups.slice(0, groupCount - 1),
  ];
  if (firstLeftOut !== undefined) {
    return { groups: keptGroups, next: firstLeftOut.candidate.positionAt(0) };
  }
  return { groups: keptGroups, next };
}

// How many of a group's leading hits fit one message together with the group's own members. The
// list measured is the group holding only its first hit, then each further hit: its JSON is the
// page's byte for byte, each further hit adding itself and one comma either way.
function countHitsFittingOneGroup(group: SessionSearchGroup): number {
  return countEntriesFittingOneFrame(
    [{ ...group, hits: group.hits.slice(0, 1) }, ...group.hits.slice(1)],
    group.hits.length,
  );
}
