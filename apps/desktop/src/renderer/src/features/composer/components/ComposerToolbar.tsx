// The composer's toolbar: the context ring, read from the session transcript for the addressed run
// so two agents running at once each report their own run's fullness. A composer addressed to the
// session and not to a run asks for no reading.

import { useMemo } from "react";
import type { ComposerProps } from "#renderer/registries/composer/registry.js";
import { useSessionStore } from "#renderer/store/session/hooks/useOpenSessionStore.js";
import { selectTranscript } from "#renderer/store/session/selectors.js";
import { useComposerAddress } from "../hooks/useComposerAddress.js";
import { ContextRing } from "../context-ring/ContextRing.js";
import { newestContextWindowReading } from "../context-ring/context-window-reading.js";

import "./ComposerToolbar.css";

/** The composer's toolbar: how full the conversation is. */
export function ComposerToolbar(props: ComposerProps): React.JSX.Element {
  const transcript = useSessionStore(props.sessionStore, selectTranscript);
  const target = useComposerAddress(props.sessionStore, props.focusedPane);
  // Folded after the address, which is an input to the fold.
  const addressedRunId = target.path === "provider-bound" ? target.targetRunId : undefined;
  const contextReading = useMemo(
    () => newestContextWindowReading(transcript, addressedRunId),
    [transcript, addressedRunId],
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
