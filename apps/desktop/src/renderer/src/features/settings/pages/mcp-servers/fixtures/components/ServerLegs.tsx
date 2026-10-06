import type { ReactNode } from "react";

import { Chip } from "#renderer/components/Chip/Chip.js";
import { DerivedFigure } from "#renderer/components/DerivedFigure/DerivedFigure.js";
import { Nothing } from "#renderer/components/Nothing/Nothing.js";
import { WireFigure } from "#renderer/components/WireFigure/WireFigure.js";
import { MCP_SERVER_STATUS_WORDS } from "../../status-words.js";
import { formatDateTime } from "#renderer/lib/wire/figures.js";
import type { McpServerLegStatus } from "@ai-sidekicks/contracts/mcp/server";
import { mcpLiveLegKeyOf } from "../live-leg-key.js";
import { toneForServerStatus } from "../status-tone.js";

/**
 * One binding's live legs, one row per session that holds it open.
 *
 * The per-leg grain is preserved, not folded: one configuration backs many concurrent
 * sessions, and two legs can honestly disagree, so one scalar would report a partial outage
 * as fine or broken. Each leg is keyed by `(sessionId, bindingId)` through `live-leg-key.ts`,
 * shared with the outcome list. The aggregate above this list is the daemon's and is never
 * recomputed here.
 */
export function ServerLegs(props: {
  readonly legs: readonly McpServerLegStatus[] | undefined;
}): ReactNode {
  const { legs } = props;
  if (legs === undefined || legs.length === 0) {
    return (
      <Nothing
        kind="empty"
        placement="inline"
        title="No session holds this binding open."
        detail="The row's status is what the last observation recorded rather than a live reading."
      />
    );
  }
  return (
    <ul className="meridian-mcp__legs">
      {legs.map((leg) => (
        <li key={mcpLiveLegKeyOf(leg)} className="meridian-mcp__leg">
          <Chip
            label={MCP_SERVER_STATUS_WORDS[leg.status]}
            tone={toneForServerStatus(leg.status)}
          />
          <span className="meridian-settings-page__aside">in session</span>
          <WireFigure value={leg.sessionId} />
          {leg.observedAt === undefined ? (
            <span className="meridian-settings-page__aside">observed at no recorded time</span>
          ) : (
            <>
              <span className="meridian-settings-page__aside">observed</span>
              <DerivedFigure text={formatDateTime(leg.observedAt)} />
            </>
          )}
        </li>
      ))}
    </ul>
  );
}
