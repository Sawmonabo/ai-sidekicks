import type { ReactNode } from "react";

import { Chip } from "#renderer/components/Chip/Chip.js";
import { WireFigure } from "#renderer/components/WireFigure/WireFigure.js";
import { Nothing } from "#renderer/components/Nothing/Nothing.js";
import { MCP_SERVER_STATUS_WORDS } from "../../status-words.js";
import { useDrawOverlayScrollbar } from "#renderer/hooks/useDrawOverlayScrollbar.js";
import { formatRelativeTime, formatZonedDateTime } from "#renderer/lib/wire/figures.js";
import type { McpServerLegStatus } from "@ai-sidekicks/contracts/mcp/server";
import {
  listedSessionOf,
  type SessionDirectoryState,
} from "#renderer/store/session/directory/state.js";
import { mcpLiveLegKeyOf } from "../live-leg-key.js";
import { toneForServerStatus } from "../status-tone.js";
import { SessionName } from "./SessionName.js";
import { useClockLocale } from "#renderer/services/platform/hooks/useClockLocale.js";

/**
 * One binding's readings, one line per running session that uses it: the session, its state word
 * and how long ago the reading was updated, or the state word alone for a reading with no time.
 *
 * The per-session grain is preserved, not folded: one configuration backs many concurrent
 * sessions, and two can honestly disagree, so one scalar would report a partial outage as fine or
 * broken. Each line is keyed by `(sessionId, bindingId)` through `live-leg-key.ts`, shared with
 * the outcome list. A session is named as the session list names it, never by its id, and until
 * the list names it the line carries no name. The aggregate above this list is the daemon's and is
 * never recomputed here.
 */
export function ServerLegs(props: {
  readonly legs: readonly McpServerLegStatus[] | undefined;
  readonly sessionDirectory: SessionDirectoryState;
  /** The instant each reading's age is counted to, in epoch milliseconds. */
  readonly nowMilliseconds: number;
}): ReactNode {
  const { legs, sessionDirectory, nowMilliseconds } = props;
  const scrollerRef = useDrawOverlayScrollbar<HTMLDivElement>();
  const clockLocale = useClockLocale();
  if (legs === undefined || legs.length === 0) {
    return <Nothing kind="empty" placement="inline" title="No running session uses this server." />;
  }
  return (
    <div className="meridian-mcp__scroller" ref={scrollerRef}>
      <ul className="meridian-mcp__legs">
        {legs.map((leg) => {
          const entry = listedSessionOf(sessionDirectory, leg.sessionId);
          return (
            <li key={mcpLiveLegKeyOf(leg)} className="meridian-mcp__leg">
              {entry === undefined ? null : (
                <>
                  <SessionName entry={entry} />
                  <span className="meridian-settings-page__aside">·</span>
                </>
              )}
              <Chip
                label={MCP_SERVER_STATUS_WORDS[leg.status]}
                tone={toneForServerStatus(leg.status)}
              />
              {leg.observedAt === undefined ? null : (
                <>
                  <span className="meridian-settings-page__aside">· updated</span>
                  <WireFigure
                    value={formatRelativeTime(leg.observedAt, nowMilliseconds)}
                    hoverLabel={formatZonedDateTime(leg.observedAt, clockLocale)}
                  />
                </>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
