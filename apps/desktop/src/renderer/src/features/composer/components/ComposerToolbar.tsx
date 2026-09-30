// The composer's trailing rail: the context meter. The attachment strip is not mounted
// until the composer has an ingest port to hand its staged list.
//
// The rail selects the session's timeline once and folds it to the newest context reading
// of the ADDRESSED RUN. The address is an input to the fold, not a session-wide sweep, so
// two agents running at once each report their own run's fullness. A composer addressed to
// the session and not to a run asks the fold for nothing.

import { useMemo } from "react";
import type { ComposerProps } from "@renderer/registries/composer/composer-registry.js";
import { useSessionStore } from "@renderer/store/session/hooks/useOpenSessionStore.js";
import { type ProjectedSessionEvent } from "@renderer/store/session/entities/entities.js";
import { type SessionStoreState } from "@renderer/store/session/session-state.js";
import { useComposerAddress } from "../hooks/useComposerAddress.js";
import { ContextRing } from "../context-ring/ContextRing.js";
import { newestContextWindowReading } from "../context-ring/context-window-reading.js";

import "./ComposerToolbar.css";

/**
 * The one selector, at module scope so its identity is stable across renders.
 *
 * It returns a STORED reference — the timeline array itself — which is what makes
 * the store's `Object.is` comparison a pointer check. A selector that mapped or
 * filtered here would rebuild an array every notification and re-render the rail on
 * every event in the session.
 */
const selectTimeline = (state: SessionStoreState): readonly ProjectedSessionEvent[] =>
  state.timeline;

/** The composer's trailing rail: how full the conversation is. */
export function ComposerToolbar(props: ComposerProps): React.JSX.Element {
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
          <ContextRing reading={contextReading} />
        </div>
      </div>
    </div>
  );
}
