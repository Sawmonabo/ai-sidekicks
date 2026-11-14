// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// `transcript.search`: one session's own search over every row it holds, loaded on screen or not.

import type { EventCursor, SessionId } from "../session/id.js";
import type { SearchMatchRange } from "../session/methods.js";

/**
 * One page of hits and the session's whole match count, split on `hasMore`.
 */
export type TranscriptSearchResponse =
  | {
      /**
       * The session's whole match count.
       */
      matchCount: number;
      /**
       * The hits, newest first.
       *
       * @minItems 1
       * @maxItems 256
       */
      hits: [TranscriptSearchHit, ...TranscriptSearchHit[]];
      /**
       * More hits follow.
       */
      hasMore: true;
      /**
       * Where to continue.
       */
      nextCursor: EventCursor;
    }
  | {
      /**
       * The session's whole match count.
       */
      matchCount: number;
      /**
       * The hits, newest first.
       *
       * @maxItems 256
       */
      hits: TranscriptSearchHit[];
      /**
       * No hits follow.
       */
      hasMore: false;
    };

/**
 * Searches one session. Hits come newest first; `beforeCursor` continues from the previous page's
 * `nextCursor`.
 */
export interface TranscriptSearchRequest {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The text to find.
   */
  query: string;
  /**
   * Continue before this position.
   */
  beforeCursor?: EventCursor;
  /**
   * The most hits to answer.
   */
  limit?: number;
}
/**
 * One row holding a match: where it is in the session, and the line the match sits in. Its
 * ranges run in order, never overlap, and sit inside the snippet, counted in UTF-16 units.
 */
export interface TranscriptSearchHit {
  /**
   * The row.
   */
  rowId: string;
  /**
   * The row's position, which a `transcript.read` around it loads from.
   */
  cursor: EventCursor;
  /**
   * The line the match sits in.
   */
  snippet: string;
  /**
   * The matched stretches to mark.
   *
   * @minItems 1
   */
  matchRanges: [SearchMatchRange, ...SearchMatchRange[]];
}

export {
  validateTranscriptSearchHit,
  validateTranscriptSearchRequest,
  validateTranscriptSearchResponse,
} from "../checks/transcript/search.js";
