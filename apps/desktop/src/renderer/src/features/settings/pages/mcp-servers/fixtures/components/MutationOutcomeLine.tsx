import type { ReactNode } from "react";

import { Nothing } from "#renderer/components/Nothing/Nothing.js";
import { InlineRefusal } from "#renderer/components/Refusal/InlineRefusal.js";
import type { McpLiveApplicationResult } from "@ai-sidekicks/contracts/mcp/mcp";
import { formatWireString } from "#renderer/lib/wire/figures.js";
import {
  sessionDisplayTitleOf,
  type SessionDirectoryState,
} from "#renderer/store/session-directory/session-directory.js";
import { settleLineFor } from "../../change-settle-words.js";
import { mcpLiveLegKeyOf } from "../live-leg-key.js";
import type { McpMutationOutcome } from "../mcp-mutation.js";

/**
 * What the last change to one control did, in place: one line for each grade the service
 * answered, saying when the change takes effect, then one line for each running session it
 * failed on, named as the session list names it.
 *
 * A partial outcome reads as one: a change can be saved and still miss one running session, and
 * a single verdict would leave that session on the old setting while the person believes it
 * moved. No grade, outcome value, error code or session id reaches the screen.
 */
export function MutationOutcomeLine(props: {
  readonly outcome: McpMutationOutcome;
  /** The service's sessions, which name a session the change failed on. */
  readonly sessionDirectory: SessionDirectoryState | undefined;
}): ReactNode {
  const { outcome, sessionDirectory } = props;
  if (outcome.kind === "idle") {
    return null;
  }
  if (outcome.kind === "sending") {
    return (
      <Nothing
        kind="not-loaded"
        placement="inline"
        title="Asking the background service to apply this."
      />
    );
  }
  if (outcome.kind === "refused") {
    return <InlineRefusal code={outcome.refusal.code} detail={outcome.refusal.detail} />;
  }
  const { binding, settlement } = outcome;
  const failedSessions = (settlement.liveResults ?? []).filter(
    (liveResult) => liveResult.outcome === "failed",
  );
  return (
    <div className="meridian-mcp__outcome" role="status">
      {settlement.grades.map((grade) => (
        <p key={grade} className="meridian-settings-page__state">
          {settleLineFor(grade, binding.provider)}
        </p>
      ))}
      {failedSessions.map((liveResult) => (
        <p key={mcpLiveLegKeyOf(liveResult)} className="meridian-settings-page__state">
          {renderSessionName(liveResult, sessionDirectory)} is still running with the old setting.
        </p>
      ))}
    </div>
  );
}

/**
 * The session a change failed on, as the session list names it, an untitled one faint and
 * italic. Where the directory does not name it, the line says only that a session did.
 */
function renderSessionName(
  liveResult: McpLiveApplicationResult,
  sessionDirectory: SessionDirectoryState | undefined,
): ReactNode {
  const entry =
    sessionDirectory?.status === "served"
      ? sessionDirectory.sessions.find((session) => session.sessionId === liveResult.sessionId)
      : undefined;
  if (entry === undefined) {
    return "A session";
  }
  const title = sessionDisplayTitleOf(entry);
  return title.isUntitled ? (
    <span className="meridian-mcp__untitled-session">{title.text}</span>
  ) : (
    formatWireString(title.text)
  );
}
