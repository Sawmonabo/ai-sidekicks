import type { ReactNode } from "react";

import { LoadingNotice } from "#renderer/components/LoadingNotice/LoadingNotice.js";
import { InlineRefusal } from "#renderer/components/Refusal/InlineRefusal.js";
import type { Clock } from "#renderer/lib/clock.js";
import {
  listedSessionOf,
  type SessionDirectoryState,
} from "#renderer/store/session/directory/state.js";
import { settleLineFor } from "../../change-settle-words.js";
import { mcpLiveLegKeyOf } from "../live-leg-key.js";
import type { McpMutationOutcome } from "../mutation.js";
import { SessionName } from "./SessionName.js";

/**
 * What the last change to one control did, in place: `Sending…` while it is on its way, once past
 * the short delay; then one line for each grade the service answered, saying when the change
 * takes effect, and one line for each running session it failed on, named as the session list
 * names it. A session the list does not name yet gets its line only once its name arrives, so no
 * placeholder is ever read out as a name.
 *
 * A partial outcome reads as one: a change can be saved and still miss one running session, and
 * a single verdict would leave that session on the old setting while the person believes it
 * moved. No grade, outcome value, error code or session id reaches the screen.
 */
export function MutationOutcomeLine(props: {
  readonly outcome: McpMutationOutcome;
  /** The service's sessions, which name a session the change failed on. */
  readonly sessionDirectory: SessionDirectoryState;
  /** The window's clock, which holds `Sending…` back for the short delay. */
  readonly clock: Clock;
}): ReactNode {
  const { outcome, sessionDirectory, clock } = props;
  if (outcome.kind === "idle") {
    return null;
  }
  if (outcome.kind === "sending") {
    return <LoadingNotice clock={clock} placement="inline" title="Sending…" />;
  }
  if (outcome.kind === "refused") {
    return <InlineRefusal code={outcome.refusal.code} detail={outcome.refusal.detail} />;
  }
  const { binding, settlement } = outcome;
  const failedSessions = (settlement.liveResults ?? []).flatMap((liveResult) => {
    const entry =
      liveResult.outcome === "failed"
        ? listedSessionOf(sessionDirectory, liveResult.sessionId)
        : undefined;
    return entry === undefined ? [] : [{ liveResult, entry }];
  });
  return (
    <div className="meridian-mcp__outcome" role="status">
      {settlement.grades.map((grade) => (
        <p key={grade} className="meridian-settings-page__state">
          {settleLineFor(grade, binding.provider)}
        </p>
      ))}
      {failedSessions.map(({ liveResult, entry }) => (
        <p key={mcpLiveLegKeyOf(liveResult)} className="meridian-settings-page__state">
          <SessionName entry={entry} /> is still running with the old setting.
        </p>
      ))}
    </div>
  );
}
