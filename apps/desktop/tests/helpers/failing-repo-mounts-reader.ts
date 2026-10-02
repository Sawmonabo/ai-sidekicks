// A repo mounts reader whose every pass fails, for a suite outside the repos feature that proves
// what a failed dependent read does to the session screen. It is the real reader, so the suite
// also proves the reader records its failure on the session.

import type { Clock } from "@renderer/lib/clock.js";
import { RepoMountsReader } from "@renderer/features/repos/mounts/repo-mounts-reader.js";
import { scriptedRepoOperations } from "@renderer/features/repos/repo-operations.test-support.js";
import type { SessionStore } from "@renderer/store/session/session-store.js";

/** A reader over this session whose repository calls all reject, so each pass fails. */
export function failingRepoMountsReader(
  sessionStore: SessionStore,
  clock: Clock,
): RepoMountsReader {
  return new RepoMountsReader({ operations: scriptedRepoOperations(), sessionStore, clock });
}
