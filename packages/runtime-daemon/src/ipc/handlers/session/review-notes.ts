// The held review note calls: `session.reviewNoteAdd`, `session.reviewNoteUpdate` and
// `session.reviewNoteRemove` change a session's notes, and `session.reviewNoteList` follows them,
// the whole set at once and again on each change, each note's stranded mark read fresh.

import type { MethodRegistry } from "@ai-sidekicks/contracts/jsonrpc/registry";
import {
  REVIEW_NOTE_METHOD_DESCRIPTORS,
  type ReviewNoteSet,
} from "@ai-sidekicks/contracts/review-note";

import type { SessionReviewNoteStore } from "../../../session/review-note/store.js";
import { openLatestValueStream, type LatestValueStreamDeps } from "../../latest-value-stream.js";
import {
  registerDescribedMethod,
  registerDescribedSubscription,
} from "../register-described-method.js";

/** What the review note handlers call. */
export interface SessionReviewNoteMethodsDeps extends LatestValueStreamDeps {
  readonly notes: Pick<SessionReviewNoteStore, "add" | "update" | "remove" | "follow">;
}

/** Binds the four review note calls onto the registry, answered from `deps.notes`. */
export function registerSessionReviewNoteMethods(
  registry: MethodRegistry,
  deps: SessionReviewNoteMethodsDeps,
): void {
  registerDescribedMethod(
    registry,
    REVIEW_NOTE_METHOD_DESCRIPTORS["session.reviewNoteAdd"],
    (request) => deps.notes.add(request),
  );
  registerDescribedMethod(
    registry,
    REVIEW_NOTE_METHOD_DESCRIPTORS["session.reviewNoteUpdate"],
    (request) => deps.notes.update(request),
  );
  registerDescribedMethod(
    registry,
    REVIEW_NOTE_METHOD_DESCRIPTORS["session.reviewNoteRemove"],
    (request) => deps.notes.remove(request),
  );
  const list = REVIEW_NOTE_METHOD_DESCRIPTORS["session.reviewNoteList"];
  registerDescribedSubscription(registry, list, (request, context) =>
    openLatestValueStream<ReviewNoteSet>(deps, {
      method: list.method,
      emissionSchema: list.emissionSchema,
      transportId: context.transportId,
      follow: (outlet) => deps.notes.follow(request.sessionId, outlet),
    }),
  );
}
