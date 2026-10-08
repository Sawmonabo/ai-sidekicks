// The newest event of each kind a standing fact is read from, held apart from the window: a run's
// newest window measurement and compaction, a shell's newest change of holder, each event that
// brought an agent into the session, and each agent's newest switch of provider binding. The window
// lets go of rows far from the reader and the tail detaches, but these facts stand until a newer
// event of the same kind and subject replaces them, so the store keeps the events and every reader
// folds them as it would the log.
//
// A read seeds them (`session.read`'s standing events), and every row the stream admits, a page
// recovers or a window read carries advances them. Newest by sequence wins whatever order rows
// arrive in, since a backward page delivers older rows after newer ones.

import { AGENT_PROVIDER_BINDING_CHANGED_EVENT } from "@ai-sidekicks/contracts/agent/provider-binding";
import type { SessionEventType } from "@ai-sidekicks/contracts/event/registry";
import { PTY_CONTROL_CHANGED_EVENT } from "@ai-sidekicks/contracts/pty";

import { readWireString } from "#renderer/lib/wire/strings.js";
import type { ProjectedSessionEvent } from "./entities/vocabulary.js";
import {
  CONTEXT_COMPACTED_EVENT_KIND,
  CONTEXT_WINDOW_EVENT_KIND,
  readContextWindow,
} from "./events/context-window-reading.js";
import { readResolvedAgentId } from "./events/run/entity-body.js";
import { RUN_QUEUED_EVENT_KIND } from "./events/run/state-kinds.js";

/**
 * The event kind of the session's birth, which brings the lead into the session. Typed against the
 * taxonomy so a misspelling fails to compile.
 */
export const SESSION_CREATED_EVENT_KIND: Extract<SessionEventType, "session.created"> =
  "session.created";

/**
 * `held` with each event of `events` a standing fact reads in place of the held event of its kind
 * and subject, where it is newer, in sequence order. Answers `held` itself when nothing changed, so
 * a reader keyed on its identity does not fold again.
 */
export function mergeStandingEvents(
  held: readonly ProjectedSessionEvent[],
  events: readonly ProjectedSessionEvent[],
): readonly ProjectedSessionEvent[] {
  let merged: ProjectedSessionEvent[] | undefined;
  for (const event of events) {
    const subject = standingSubjectOf(event);
    if (subject === undefined) {
      continue;
    }
    const current = merged ?? held;
    const index = current.findIndex(
      (standing) => standing.kind === event.kind && standingSubjectOf(standing) === subject,
    );
    const standing = current[index];
    if (standing !== undefined && standing.sequence >= event.sequence) {
      continue;
    }
    merged ??= [...held];
    if (index === -1) {
      merged.push(event);
    } else {
      merged[index] = event;
    }
  }
  return merged === undefined ? held : merged.sort((left, right) => left.sequence - right.sequence);
}

// The subject of an event whose kind has one per session, and of a lease change naming no shell,
// which every shell's fold reads. No run, shell or agent id is empty, so it names none of them.
const UNNAMED_SUBJECT = "";

/** What a standing event is about, or `undefined` for an event no standing fact reads. */
function standingSubjectOf(event: ProjectedSessionEvent): string | undefined {
  switch (event.kind) {
    // A row that measures no window never stands over an older one that did.
    case CONTEXT_WINDOW_EVENT_KIND:
      return readContextWindow(event) === undefined
        ? undefined
        : readWireString(event.payload?.["runId"]);
    case CONTEXT_COMPACTED_EVENT_KIND:
      return readWireString(event.payload?.["runId"]);
    // Readable or not: an unreadable change is what keeps a shell's lease unread.
    case PTY_CONTROL_CHANGED_EVENT:
      return readWireString(event.payload?.["terminalId"]) ?? UNNAMED_SUBJECT;
    case SESSION_CREATED_EVENT_KIND:
      return UNNAMED_SUBJECT;
    case RUN_QUEUED_EVENT_KIND:
      return readResolvedAgentId(event.payload);
    case AGENT_PROVIDER_BINDING_CHANGED_EVENT:
      return readWireString(event.payload?.["agentId"]);
    default:
      return undefined;
  }
}
