import type { ReactNode } from "react";

import {
  Chip,
  DerivedFigure,
  Nothing,
  WireFigure,
  formatDateTime,
} from "../../../../primitives/index.js";
import type { GrowthMcpServerLegStatus } from "../../../../bridge/index.js";
import { toneForServerStatus } from "./server-status-tone.js";

/**
 * One binding's live legs, one row per session that holds it open.
 *
 * THE GRAIN IS PRESERVED RATHER THAN FOLDED. One configuration backs however many
 * concurrent sessions there are, and two legs of one binding can honestly disagree —
 * a session that authorized and one that has not, a process that died under one
 * session and not another. A surface that showed one scalar would report a partial
 * outage as either fine or broken, and both readings would be wrong.
 *
 * THE AGGREGATE ABOVE THIS LIST IS THE DAEMON'S AND IS NEVER RECOMPUTED HERE. The
 * severity rule that folds these legs into the row's own status lives at the daemon;
 * this component renders the legs and the row renders the aggregate, and neither
 * derives the other. Two rows of this page make that testable: one binding's legs
 * agree with its aggregate and another's do not, and the disagreement is the point.
 */
export function ServerLegs(props: {
  readonly legs: readonly GrowthMcpServerLegStatus[] | undefined;
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
        <li key={leg.bindingId} className="meridian-mcp__leg">
          <Chip label={leg.status} mono tone={toneForServerStatus(leg.status)} />
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
