// The messages between the search thread and the daemon's main thread, and the errors a search
// throws, carried across as plain data and rebuilt as the class the wire mapping reads. Each
// request is answered once, in the order it was sent.

import { EventCursorUnresolvableError } from "@ai-sidekicks/contracts/error";
import type {
  SessionSearchRequest,
  SessionSearchResponse,
} from "@ai-sidekicks/contracts/session/methods";
import type {
  TranscriptSearchRequest,
  TranscriptSearchResponse,
} from "@ai-sidekicks/contracts/transcript/search";

import { DaemonDomainError, type DomainErrorJsonRpcCode } from "../../../ipc/domain-error.js";
import { SessionNotFoundError } from "../../../ipc/session-errors.js";

/** What the main thread asks of the search thread. */
export type SearchThreadRequest =
  | { readonly type: "session.search"; readonly request: SessionSearchRequest }
  | { readonly type: "transcript.search"; readonly request: TranscriptSearchRequest }
  | { readonly type: "close" };

/** An error a search threw, as plain data: each kind the wire mapping tells apart, or any other. */
export type CarriedSearchError =
  | {
      readonly kind: "domain";
      readonly message: string;
      readonly code: string;
      readonly jsonRpcCode: DomainErrorJsonRpcCode | undefined;
      readonly detail: Record<string, unknown> | undefined;
    }
  | {
      readonly kind: "session_not_found";
      readonly message: string;
      readonly fields: Record<string, unknown> | undefined;
    }
  | { readonly kind: "event_cursor_unresolvable"; readonly cursor: string }
  | { readonly kind: "other"; readonly message: string; readonly stack: string | undefined };

/** What the search thread answers: once when its connection is open, then once per request. */
export type SearchThreadReply =
  | { readonly type: "opened" }
  | { readonly type: "open-failed"; readonly error: CarriedSearchError }
  | { readonly type: "session-searched"; readonly response: SessionSearchResponse }
  | { readonly type: "transcript-searched"; readonly response: TranscriptSearchResponse }
  | { readonly type: "search-failed"; readonly error: CarriedSearchError }
  | { readonly type: "closed" };

/** What the search thread is started with. */
export interface SearchThreadWorkerData {
  readonly databasePath: string;
}

/** Carries a thrown value across the thread boundary, which keeps only plain data. */
export function carrySearchError(error: unknown): CarriedSearchError {
  if (error instanceof DaemonDomainError) {
    return {
      kind: "domain",
      message: error.message,
      code: error.code,
      jsonRpcCode: error.jsonRpcCode,
      detail: error.detail,
    };
  }
  if (error instanceof SessionNotFoundError) {
    return { kind: "session_not_found", message: error.message, fields: error.fields };
  }
  if (error instanceof EventCursorUnresolvableError) {
    return { kind: "event_cursor_unresolvable", cursor: error.cursor };
  }
  return error instanceof Error
    ? { kind: "other", message: error.message, stack: error.stack }
    : { kind: "other", message: String(error), stack: undefined };
}

/** The error a carried one was, as the class it was thrown as, or a plain `Error` for any other. */
export function rebuildSearchError(carried: CarriedSearchError): Error {
  switch (carried.kind) {
    case "domain":
      return new DaemonDomainError(carried.message, {
        code: carried.code,
        ...(carried.jsonRpcCode === undefined ? {} : { jsonRpcCode: carried.jsonRpcCode }),
        ...(carried.detail === undefined ? {} : { detail: carried.detail }),
      });
    case "session_not_found":
      return new SessionNotFoundError(carried.message, carried.fields);
    case "event_cursor_unresolvable":
      return new EventCursorUnresolvableError(carried.cursor);
    case "other": {
      const error = new Error(carried.message);
      if (carried.stack !== undefined) {
        error.stack = carried.stack;
      }
      return error;
    }
  }
}
