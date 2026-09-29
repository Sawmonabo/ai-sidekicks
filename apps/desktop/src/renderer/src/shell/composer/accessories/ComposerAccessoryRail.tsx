// The composer's trailing rail: the context meter. The attachment strip is not mounted
// until the composer has an ingest port to hand its carrier.
//
// The rail selects the session's timeline once and folds it to the newest context reading
// of the ADDRESSED RUN. The address is an input to the fold, not a session-wide sweep, so
// two agents running at once each report their own run's fullness. A composer addressed to
// the session and not to a run asks the fold for nothing.

import { useMemo } from "react";
import type { ComposerSeatProps } from "../../../console/seats/index.js";
import {
  useSessionStore,
  type ConsoleSessionEvent,
  type SessionStoreState,
} from "../../../console/store/index.js";
import { useComposerAddress } from "../composer-address.js";
import { ContextMeter } from "./context-meter/ContextMeter.js";
import { newestContextWindowReading } from "./usage-readings.js";

/**
 * The one selector, at module scope so its identity is stable across renders.
 *
 * It returns a STORED reference — the timeline array itself — which is what makes
 * the store's `Object.is` comparison a pointer check. A selector that mapped or
 * filtered here would rebuild an array every notification and re-render the rail on
 * every event in the session.
 */
const selectTimeline = (state: SessionStoreState): readonly ConsoleSessionEvent[] => state.timeline;

/** The composer's trailing rail: how full the conversation is. */
export function ComposerAccessoryRail(props: ComposerSeatProps): React.JSX.Element {
  const timeline = useSessionStore(props.sessionStore, selectTimeline);
  const address = useComposerAddress(props.sessionStore, props.focusedPane);
  // Folded AFTER the address, because the address is an input: the reading this
  // composer reports is the addressed run's own.
  const addressedRunId =
    address.target.path === "provider-bound" ? address.target.targetRunId : undefined;
  const contextReading = useMemo(
    () => newestContextWindowReading(timeline, addressedRunId),
    [timeline, addressedRunId],
  );

  return (
    <div className="meridian-composer__rail">
      <div className="meridian-composer__accessories">
        <div className="meridian-composer__meters">
          <ContextMeter reading={contextReading} />
        </div>
      </div>
    </div>
  );
}
