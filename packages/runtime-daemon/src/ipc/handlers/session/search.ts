// The two session searches: `session.search` across every session's index rows, and
// `session.fileSearch`, the `@` file search in one session's working folder. Both are reads, so a
// read-only client can still search across a protocol version mismatch. A damaged session's hits
// stop at its last good point, where every read of it stops.

import type { MethodRegistry } from "@ai-sidekicks/contracts/jsonrpc/registry";
import { decodeEventCursor } from "@ai-sidekicks/contracts/session/event-cursor";
import {
  SESSION_METHOD_DESCRIPTORS,
  type SessionSearchGroup,
  type SessionSearchRequest,
  type SessionSearchResponse,
} from "@ai-sidekicks/contracts/session/methods";

import type { DamagedFromSequenceReader } from "../../../events/session/read.js";
import type { FileSearchService } from "../../../session/search/files/service.js";
import type { SearchThread } from "../../../session/search/thread/handle.js";

import { registerDescribedMethod } from "../register-described-method.js";

/** What `session.search`'s handler reads through: the search thread, off the main thread. */
export interface SessionSearchDeps {
  readonly sessionSearch: Pick<SearchThread, "searchSessions">;
  /** Where a damaged session's reads stop, and so its hits. */
  readonly readDamagedFromSequence: DamagedFromSequenceReader;
}

/** Binds `session.search` onto the registry. */
export function registerSessionSearch(registry: MethodRegistry, deps: SessionSearchDeps): void {
  registerDescribedMethod(registry, SESSION_METHOD_DESCRIPTORS["session.search"], async (request) =>
    searchBeforeDamagedPoints(request, deps),
  );
}

// A page with each damaged session's hits at or past its last good point left out. A continuing
// page those took every hit from is followed by the next, since a continuing page carries a hit.
async function searchBeforeDamagedPoints(
  request: SessionSearchRequest,
  deps: SessionSearchDeps,
): Promise<SessionSearchResponse> {
  let page = await deps.sessionSearch.searchSessions(request);
  for (;;) {
    const groups = page.groups.flatMap((group) =>
      keepHitsBeforeDamagedPoint(group, deps.readDamagedFromSequence),
    );
    if (!page.hasMore) {
      return { groups, hasMore: false };
    }
    const [firstGroup, ...laterGroups] = groups;
    if (firstGroup !== undefined) {
      return { ...page, groups: [firstGroup, ...laterGroups] };
    }
    page = await deps.sessionSearch.searchSessions({ ...request, afterCursor: page.nextCursor });
  }
}

// The group with only the hits before its session's last good point; none when no hit is left.
function keepHitsBeforeDamagedPoint(
  group: SessionSearchGroup,
  readDamagedFromSequence: DamagedFromSequenceReader,
): SessionSearchGroup[] {
  const damagedFromSequence = readDamagedFromSequence(group.sessionId);
  if (damagedFromSequence === undefined) {
    return [group];
  }
  const hits = group.hits.filter((hit) => decodeEventCursor(hit.cursor) < damagedFromSequence);
  return hits.length === 0 ? [] : [{ ...group, hits }];
}

/** What `session.fileSearch`'s handler reads from. */
export interface SessionFileSearchDeps {
  /**
   * An unknown session throws `SessionNotFoundError` (`session.not_found`); a working folder
   * that is not in place or cannot be listed throws its own error, which carries the reason.
   */
  readonly fileSearch: Pick<FileSearchService, "search">;
}

/** Binds `session.fileSearch` onto the registry. */
export function registerSessionFileSearch(
  registry: MethodRegistry,
  deps: SessionFileSearchDeps,
): void {
  registerDescribedMethod(
    registry,
    SESSION_METHOD_DESCRIPTORS["session.fileSearch"],
    async (request) => deps.fileSearch.search(request),
  );
}
