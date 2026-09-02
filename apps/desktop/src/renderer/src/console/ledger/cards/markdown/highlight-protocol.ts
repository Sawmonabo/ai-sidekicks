// The two messages that cross the highlight worker's boundary.
//
// Two sides of one seam share a module (`apps/desktop/AGENTS.md`): the scheduler posts
// a request and the worker answers one, and a second declaration of either shape on the
// other side would be the drift that rule exists to prevent — with a structured-clone
// boundary in between, where a mismatch is a silently ignored field rather than a type
// error.
//
// A LEAF ON PURPOSE. This module imports one type and nothing else, so the worker's
// bundle does not acquire the scheduler, the `Worker` construction, or React by
// importing the protocol it answers.

import type { CodeTokenLine, HighlightableLanguage } from "./code-tokenizer.js";

/** What the scheduler posts. `requestId` is the scheduler's, monotonic within a page. */
export interface HighlightRequestMessage {
  readonly requestId: number;
  readonly source: string;
  readonly language: HighlightableLanguage;
}

/**
 * What the worker posts back.
 *
 * `lines` is `undefined` for a block the worker could not tokenise — a grammar that
 * failed to load, a core that could not be created. The caller renders the block plain,
 * so the absence is a value rather than a rejected promise: a worker that answers
 * nothing at all would leave the request pending for the life of the page.
 */
export interface HighlightResponseMessage {
  readonly requestId: number;
  readonly lines: readonly CodeTokenLine[] | undefined;
}
