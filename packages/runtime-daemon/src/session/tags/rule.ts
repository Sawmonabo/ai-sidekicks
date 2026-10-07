// What a session tag may be. The person's `Add tag` and an agent's session update both pass a tag
// through here before anything is written, so the two can never hold different rules.

import { SESSION_TAG_REFUSED_CODE } from "@ai-sidekicks/contracts/session/tags";

import { DaemonDomainError } from "../../ipc/domain-error.js";

// Any Unicode whitespace, so a tag is one word to search for.
const WHITESPACE = /\s/u;
const NESTING_SEPARATOR = "/";

/**
 * Throws a `session.tag_refused` error for a tag that is empty, holds any whitespace, or has an
 * empty level around a `/` (`/billing`, `billing//stripe`, `billing/`).
 */
export function validateSessionTag(tag: string): void {
  const reason = refusalReasonOf(tag);
  if (reason !== undefined) {
    throw new DaemonDomainError(reason, { code: SESSION_TAG_REFUSED_CODE, detail: { tag } });
  }
}

function refusalReasonOf(tag: string): string | undefined {
  if (tag === "") {
    return "A tag cannot be empty.";
  }
  if (WHITESPACE.test(tag)) {
    return "A tag cannot hold a space.";
  }
  if (tag.split(NESTING_SEPARATOR).includes("")) {
    return "Each level of a tag needs a name.";
  }
  return undefined;
}
