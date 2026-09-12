// How every suite over `CreateChannelDraft` drives one, in one place.
//
// A ROLE AND NOT A SECOND HARNESS. `create-channel.test-support.tsx` renders the form
// and hands back its controls; this drives the CLASS and reads the request it composes,
// which is what the two draft suites beside it do and what no rendered case can see.

import type { ChannelCreateRequest } from "./channel-writes.js";
import { CreateChannelDraft } from "./create-channel-draft.js";
import { SESSION_ID } from "./channels.test-support.js";

/** The request this draft composes, or a failure naming what it is still missing. */
export function requestOf(draft: CreateChannelDraft): ChannelCreateRequest {
  const readiness = draft.readiness(SESSION_ID);
  if (readiness.status !== "ready") {
    throw new Error(`the draft is still missing: ${readiness.missing.join(", ")}`);
  }
  return readiness.request;
}

/** What the draft says it is still waiting on. */
export function missingFrom(draft: CreateChannelDraft): readonly string[] {
  const readiness = draft.readiness(SESSION_ID);
  return readiness.status === "incomplete" ? readiness.missing : [];
}

/** A named draft, which is the shortest thing that composes a request. */
export function namedDraft(name = "review"): CreateChannelDraft {
  const draft = new CreateChannelDraft();
  draft.setName(name);
  return draft;
}
