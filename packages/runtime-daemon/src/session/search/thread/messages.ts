// The messages between the search thread and the daemon's main thread, and the errors a request
// throws, carried across as plain data and rebuilt as the class the wire mapping reads. A request
// carries an id its answer repeats, since a merge resolves off the thread while searches go on. The
// thread also tells the main thread, unasked, when an index commit is durable, so the outbox rows
// it holds are deleted, and when applying the outbox failed.

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
import {
  carryError,
  rebuildError,
  type CarriedError,
} from "../../../worker-thread/carried-error.js";
import type { AppliedOutbox } from "../index/outbox.js";
import type { SearchIndexRebuildReason } from "../index/rebuild.js";

/** A request the main thread makes of the search thread, each answered once. */
export type SearchThreadCall =
  | { readonly type: "session.search"; readonly request: SessionSearchRequest }
  | { readonly type: "transcript.search"; readonly request: TranscriptSearchRequest }
  | { readonly type: "merge" }
  | { readonly type: "close" };

/**
 * What the main thread sends: a request with the id its answer repeats, or the notice that writes
 * committed, which nothing answers.
 */
export type SearchThreadRequest =
  | (SearchThreadCall & { readonly id: number })
  | { readonly type: "writes-committed" };

/** A request's error as plain data: each kind the wire mapping tells apart, or any other. */
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
  | ({ readonly kind: "other" } & CarriedError);

/** The search thread's answer to one request. */
export type SearchThreadAnswer =
  | { readonly type: "session-searched"; readonly response: SessionSearchResponse }
  | { readonly type: "transcript-searched"; readonly response: TranscriptSearchResponse }
  | { readonly type: "merged"; readonly isMoreToMerge: boolean }
  | { readonly type: "failed"; readonly error: CarriedSearchError }
  | { readonly type: "closed" };

/**
 * What the search thread sends: once whether its index opened, then each answer with its
 * request's id, and unasked each durable index commit and a failed apply.
 */
export type SearchThreadReply =
  | { readonly type: "opened"; readonly rebuildReason: SearchIndexRebuildReason | undefined }
  | { readonly type: "open-failed"; readonly error: CarriedSearchError }
  | { readonly type: "index-applied"; readonly applied: AppliedOutbox }
  | { readonly type: "index-failed"; readonly error: CarriedSearchError }
  | (SearchThreadAnswer & { readonly id: number });

/** What the search thread is started with. */
export interface SearchThreadWorkerData {
  readonly databasePath: string;
  /** The search index's folder in the daemon's data folder. */
  readonly indexFolderPath: string;
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
  return { kind: "other", ...carryError(error) };
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
    case "other":
      return rebuildError(carried);
  }
}
