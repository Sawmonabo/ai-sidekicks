// The two session searches: `session.search` across every session's index rows, and
// `session.fileSearch`, the `@` file search in one session's working folder. Both are reads, so a
// read-only client can still search across a protocol version mismatch.

import type { MethodRegistry } from "@ai-sidekicks/contracts/jsonrpc/registry";
import { SESSION_METHOD_DESCRIPTORS } from "@ai-sidekicks/contracts/session/methods";

import type { FileSearchService } from "../../../session/search/files/service.js";
import type { SessionSearchService } from "../../../session/search/service.js";

import { registerDescribedMethod } from "../register-described-method.js";

/** What `session.search`'s handler reads from. */
export interface SessionSearchDeps {
  readonly sessionSearch: Pick<SessionSearchService, "search">;
}

/** Binds `session.search` onto the registry. */
export function registerSessionSearch(registry: MethodRegistry, deps: SessionSearchDeps): void {
  registerDescribedMethod(registry, SESSION_METHOD_DESCRIPTORS["session.search"], async (request) =>
    deps.sessionSearch.search(request),
  );
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
