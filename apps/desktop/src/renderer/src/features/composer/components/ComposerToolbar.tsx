// The composer's toolbar: the context ring, read from the session's standing events for the
// addressed run, so two agents running at once each report their own run's fullness however much of
// the log the window holds. A composer addressed to the session and not to a run asks for no
// reading.

import { useMemo } from "react";
import type { ComposerProps } from "#renderer/registries/composer/registry.js";
import { newestContextWindowReading } from "#renderer/store/session/events/context-window-reading.js";
import { useSessionStore } from "#renderer/store/session/hooks/useOpenSessionStore.js";
import { selectStandingEvents } from "#renderer/store/session/selectors.js";
import { useComposerAddress } from "../hooks/useComposerAddress.js";
import { ContextRing } from "../context-ring/ContextRing.js";

import "./ComposerToolbar.css";

/** The composer's toolbar: how full the conversation is. */
export function ComposerToolbar(props: ComposerProps): React.JSX.Element {
  const standingEvents = useSessionStore(props.sessionStore, selectStandingEvents);
  const target = useComposerAddress(props.sessionStore, props.focusedPane);
  // Folded after the address, which is an input to the fold.
  const addressedRunId = target.path === "provider-bound" ? target.targetRunId : undefined;
  const contextReading = useMemo(
    () => newestContextWindowReading(standingEvents, addressedRunId),
    [standingEvents, addressedRunId],
  );

  return (
    <div className="meridian-composer__toolbar">
      <div className="meridian-composer__toolbar-cluster">
        <div className="meridian-composer__meters">
          <ContextRing reading={contextReading} />
        </div>
      </div>
    </div>
  );
}
