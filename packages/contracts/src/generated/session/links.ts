// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The links between sessions as the person reads and changes them.

import type { SchemaCheck } from "../../schema-check.js";
import { validateSubscribeAcknowledgmentResponse } from "../checks/jsonrpc/streaming.js";
import { validateEmptyPayload } from "../checks/method-descriptor.js";
import {
  validateSessionLinkRequest,
  validateSessionRelatedListUpdate,
  validateSessionRelatedSessionSubscribeRequest,
} from "../checks/session/links.js";
import type { SubscribeAcknowledgmentResponse } from "../jsonrpc/streaming.js";
import type { EmptyPayload } from "../method-descriptor.js";
import type { SessionId } from "./id.js";

/**
 * How two sessions are linked. Every kind but `related` is written by the daemon when the event
 * that makes it happens; `related` is added on purpose and is the one a person removes.
 */
export type SessionLinkKind =
  | "started"
  | "copiedFrom"
  | "messaged"
  | "asked"
  | "mentioned"
  | "related";

/**
 * `session.relatedSession.subscribe`'s input: the session whose related sessions to follow.
 */
export interface SessionRelatedSessionSubscribeRequest {
  /**
   * The session.
   */
  sessionId: SessionId;
}
/**
 * One session linked to the followed one. `kind` is the strongest link between the two, and
 * `sessionIsSource` is true where the followed session started, copied, messaged, asked or
 * mentioned the other.
 */
export interface SessionRelatedListEntry {
  /**
   * The linked session.
   */
  sessionId: SessionId;
  /**
   * Its name; absent for an untitled session.
   */
  name?: string;
  /**
   * The strongest link.
   */
  kind: SessionLinkKind;
  /**
   * Whether the followed session is the link's source.
   */
  sessionIsSource: boolean;
  /**
   * On a `messaged` link, how many messages the two traded.
   */
  messageCount?: number;
  /**
   * Whether the pair carries a `related` link, which `Unlink` removes.
   */
  removable: boolean;
}
/**
 * Each `session.relatedSession.subscribe` emission: the whole related list, highest relevance
 * first, sent when the stream opens and again each time a link it depends on is re-scored. The
 * list fits the shared page budget.
 */
export interface SessionRelatedListUpdate {
  /**
   * The followed session.
   */
  sessionId: SessionId;
  /**
   * Its related sessions.
   */
  related: SessionRelatedListEntry[];
}
/**
 * Adds or removes a `related` link between two sessions, naming both by id so a rename changes
 * nothing. The two are different sessions: none links to itself.
 */
export interface SessionLinkRequest {
  /**
   * One session.
   */
  sessionId: SessionId;
  /**
   * The other.
   */
  targetSessionId: SessionId;
}

export {
  validateSessionLinkKind,
  validateSessionLinkRequest,
  validateSessionRelatedListEntry,
  validateSessionRelatedListUpdate,
  validateSessionRelatedSessionSubscribeRequest,
} from "../checks/session/links.js";

/** The methods of {@link SESSION_LINK_METHOD_DESCRIPTORS}, each with its checks. */
export interface SessionLinkMethodDescriptors {
  readonly "session.relatedSession.subscribe": {
    readonly method: "session.relatedSession.subscribe";
    readonly procedureType: "subscription";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<SessionRelatedSessionSubscribeRequest>;
    readonly responseCheck: SchemaCheck<SubscribeAcknowledgmentResponse>;
    readonly emissionCheck: SchemaCheck<SessionRelatedListUpdate>;
  };
  readonly "session.link.add": {
    readonly method: "session.link.add";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<SessionLinkRequest>;
    readonly responseCheck: SchemaCheck<EmptyPayload>;
  };
  readonly "session.link.remove": {
    readonly method: "session.link.remove";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<SessionLinkRequest>;
    readonly responseCheck: SchemaCheck<EmptyPayload>;
  };
}
/** The session link methods' wire contract: name, procedure type and types. */
export const SESSION_LINK_METHOD_DESCRIPTORS: SessionLinkMethodDescriptors =
  /* @__PURE__ */ Object.freeze({
    "session.relatedSession.subscribe": /* @__PURE__ */ Object.freeze({
      method: "session.relatedSession.subscribe",
      procedureType: "subscription",
      mutating: false,
      requestCheck: validateSessionRelatedSessionSubscribeRequest,
      responseCheck: validateSubscribeAcknowledgmentResponse,
      emissionCheck: validateSessionRelatedListUpdate,
    }),
    "session.link.add": /* @__PURE__ */ Object.freeze({
      method: "session.link.add",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validateSessionLinkRequest,
      responseCheck: validateEmptyPayload,
    }),
    "session.link.remove": /* @__PURE__ */ Object.freeze({
      method: "session.link.remove",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validateSessionLinkRequest,
      responseCheck: validateEmptyPayload,
    }),
  });
