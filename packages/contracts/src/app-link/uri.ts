// Writing and reading a `sidekicks://` link, the one address form that reaches a session or a
// workflow run from outside the app. `Copy link` writes it and the desktop's link handler reads
// it, in the form the command line reads, so a link is written and read alike.
//
// A link carries the target's id and nothing else: no device, no account, no token. It arrives
// from any program on the machine, so it is untrusted input: the reader accepts only the exact
// form `composeAppLink` writes and hands back nothing but a checked id.
import { APP_LINK_SCHEME, type AppLinkTarget } from "../generated/app-link/target.js";
import { validateSessionId } from "../generated/session/id.js";
import { validateWorkflowRunId } from "../generated/workflow/run/id.js";

const SESSION_HOST = "session";
const WORKFLOW_RUN_HOST = "workflow-run";

/**
 * Writes the link for a target: `sidekicks://session/<id>` or `sidekicks://workflow-run/<id>`.
 * An id is a UUID, whose characters a URI leaves unescaped, so the link needs no encoding.
 */
export function composeAppLink(target: AppLinkTarget): string {
  return target.kind === "session"
    ? `${APP_LINK_SCHEME}://${SESSION_HOST}/${target.sessionId}`
    : `${APP_LINK_SCHEME}://${WORKFLOW_RUN_HOST}/${target.workflowRunId}`;
}

/**
 * Reads a link back into its target, its id in lower case, or answers `null` when the text is not
 * exactly a link `composeAppLink` writes: another scheme or host, a trailing slash, a query, a
 * fragment, a second path segment, or an id its kind refuses.
 */
export function parseAppLink(address: string): AppLinkTarget | null {
  const prefix = `${APP_LINK_SCHEME}://`;
  if (!address.startsWith(prefix)) {
    return null;
  }
  const rest = address.slice(prefix.length);
  const slash = rest.indexOf("/");
  if (slash === -1) {
    return null;
  }
  const host = rest.slice(0, slash);
  const id = rest.slice(slash + 1);
  if (host === SESSION_HOST && validateSessionId(id)) {
    return { kind: "session", sessionId: id.toLowerCase() as typeof id };
  }
  if (host === WORKFLOW_RUN_HOST && validateWorkflowRunId(id)) {
    return { kind: "workflowRun", workflowRunId: id.toLowerCase() as typeof id };
  }
  return null;
}
