// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// A session's tags as the person adds and removes them, and the tags in use that `Add tag` suggests.

import type { EmptyPayload } from "../method-descriptor.js";
import type { Tag, TagList } from "../tag.js";
import type { SessionId } from "./id.js";

/**
 * Adds a tag to a session or removes one. A tag is matched ignoring case and nests with `/`.
 */
export interface SessionTagRequest {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The tag.
   */
  tag: Tag;
}
/**
 * The tags in use across every session, which `Add tag` suggests. They fit the shared page
 * budget.
 */
export interface SessionTagListResponse {
  /**
   * The tags.
   */
  tags: TagList;
}

/** The methods of {@link SESSION_TAG_METHOD_DESCRIPTORS}, each with its kind. */
export interface SessionTagMethodDescriptors {
  readonly "session.tag.add": {
    readonly method: "session.tag.add";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "session.tag.remove": {
    readonly method: "session.tag.remove";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "session.tag.list": {
    readonly method: "session.tag.list";
    readonly procedureType: "query";
    readonly mutating: false;
  };
}
/** The params, result and emission types of each method of {@link SESSION_TAG_METHOD_DESCRIPTORS}. */
export interface SessionTagMethodTypes {
  readonly "session.tag.add": { readonly params: SessionTagRequest; readonly result: EmptyPayload };
  readonly "session.tag.remove": {
    readonly params: SessionTagRequest;
    readonly result: EmptyPayload;
  };
  readonly "session.tag.list": {
    readonly params: EmptyPayload;
    readonly result: SessionTagListResponse;
  };
}
/** The session tag methods' wire contract: name, procedure type and types. */
export const SESSION_TAG_METHOD_DESCRIPTORS: SessionTagMethodDescriptors =
  /* @__PURE__ */ Object.freeze({
    "session.tag.add": /* @__PURE__ */ Object.freeze({
      method: "session.tag.add",
      procedureType: "mutation",
      mutating: true,
    }),
    "session.tag.remove": /* @__PURE__ */ Object.freeze({
      method: "session.tag.remove",
      procedureType: "mutation",
      mutating: true,
    }),
    "session.tag.list": /* @__PURE__ */ Object.freeze({
      method: "session.tag.list",
      procedureType: "query",
      mutating: false,
    }),
  });
