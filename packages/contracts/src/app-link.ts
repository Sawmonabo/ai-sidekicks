// The `sidekicks://` link: the one address form that reaches a session or a
// workflow run from outside the app. `Copy link` composes it, the desktop's link
// handler and `sidekicks open` parse it, and all three use the two functions here
// so the form a link is written in and the form it is read in never differ.
//
// A link carries the target's id and nothing else: no device, no account, no
// token. It arrives from any program on the machine, so it is untrusted input:
// the parser accepts only the exact form `composeAppLink` writes and hands back
// nothing but a validated id.
import { SessionIdSchema, type SessionId } from "./session/id.js";
import { WorkflowRunIdSchema, type WorkflowRunId } from "./workflow/run/id.js";

/** What a `sidekicks://` link opens: a session, or a workflow run's page. */
export type AppLinkTarget =
  | { kind: "session"; sessionId: SessionId }
  | { kind: "workflowRun"; workflowRunId: WorkflowRunId };

// The id segment holds only the characters a URI leaves unescaped (RFC 3986
// unreserved), so a composed link needs no percent-encoding and the parser never
// decodes one. Daemon-minted ids are UUIDs, which always fit.
const LINK_ID_SEGMENT = /^[A-Za-z0-9._~-]+$/u;
const APP_LINK_FORM = /^sidekicks:\/\/(session|workflow-run)\/([A-Za-z0-9._~-]+)$/u;

/**
 * Writes the link for a target: `sidekicks://session/<id>` or
 * `sidekicks://workflow-run/<runId>`. Throws a `RangeError` for an id holding a
 * character outside the link's id segment, because such a link would not parse
 * back to the same target.
 */
export function composeAppLink(target: AppLinkTarget): string {
  const [host, id] =
    target.kind === "session"
      ? ["session", target.sessionId]
      : ["workflow-run", target.workflowRunId];
  if (!LINK_ID_SEGMENT.test(id)) {
    throw new RangeError(`A ${target.kind} id with this character set has no sidekicks:// link.`);
  }
  return `sidekicks://${host}/${id}`;
}

/**
 * Reads a link back into its target, or returns `null` when the text is not
 * exactly a link `composeAppLink` writes: another scheme, another host, a
 * trailing slash, a query, a fragment, a second path segment, or an id its
 * kind's schema refuses. The caller drops and logs a `null`.
 */
export function parseAppLink(address: string): AppLinkTarget | null {
  const match = APP_LINK_FORM.exec(address);
  if (match === null) {
    return null;
  }
  const [, host, id] = match;
  if (host === "session") {
    const sessionId = SessionIdSchema.safeParse(id);
    return sessionId.success ? { kind: "session", sessionId: sessionId.data } : null;
  }
  const workflowRunId = WorkflowRunIdSchema.safeParse(id);
  return workflowRunId.success ? { kind: "workflowRun", workflowRunId: workflowRunId.data } : null;
}
