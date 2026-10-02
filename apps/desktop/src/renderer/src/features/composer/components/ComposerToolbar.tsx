// The composer's toolbar: the context ring, read from the session timeline for the addressed run
// so two agents running at once each report their own run's fullness. A composer addressed to the
// session and not to a run asks for no reading.

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
 * The one selector, at module scope so its identity is stable. It returns the stored timeline
 * array itself, so the store's `Object.is` check is a pointer check; a mapped array would re-render
 * the toolbar on every event.
 */
const selectTimeline = (state: SessionStoreState): readonly ProjectedSessionEvent[] =>
  state.timeline;

/** The composer's toolbar: how full the conversation is. */
export function ComposerToolbar(props: ComposerProps): React.JSX.Element {
  const timeline = useSessionStore(props.sessionStore, selectTimeline);
  const target = useComposerAddress(props.sessionStore, props.focusedPane);
  // Folded after the address, which is an input to the fold.
  const addressedRunId = target.path === "provider-bound" ? target.targetRunId : undefined;
  const contextReading = useMemo(
    () => newestContextWindowReading(timeline, addressedRunId),
    [timeline, addressedRunId],
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
