// One provider section's session import: the action that imports that provider's own existing
// conversations, and the one progress row it reports into.
//
// The control stays disabled while a start is out and while the import it started is read, so
// a second press cannot start another beside it. The import itself lives in
// `useProviderImport.ts`, not here: this panel may sit behind a disclosure, and anything it held
// would end when the disclosure closed.

import "./ProviderImportPanel.css";

import { InlineRefusal } from "#renderer/components/Refusal/InlineRefusal.js";
import { StandingContent } from "#renderer/components/LiveAnnouncer/StandingContent.js";
import { PROVIDER_LABELS } from "@ai-sidekicks/contracts/provider/name";
import { ImportProgressLine } from "./ImportProgressLine.js";
import type { ProviderImportModel } from "../hooks/useProviderImport.js";

/** What the panel draws: the import its caller is holding for one provider, running or not. */
export interface ProviderImportPanelProps {
  readonly model: ProviderImportModel;
}

/** The action that imports one provider's conversations, and the row that reports it. */
export function ProviderImportPanel(props: ProviderImportPanelProps): React.JSX.Element {
  const { model } = props;
  const providerLabel = PROVIDER_LABELS[model.provider];
  const actionLabel = `Import sessions from ${providerLabel}`;
  return (
    <section className="meridian-provider-import" aria-label={actionLabel}>
      <div className="meridian-provider-import__head">
        <div className="meridian-provider-import__words">
          <span className="meridian-provider-import__name">{actionLabel}</span>
          <p className="meridian-provider-import__lede">
            {`Reads the conversations ${providerLabel} already keeps and adds them to the ` +
              "sessions list. Sessions imported here are copies; import again to bring in what " +
              "the tool added since."}
          </p>
        </div>
        <button
          type="button"
          className={
            "meridian-provider-import__submit meridian-action-button " +
            "meridian-action-button--regular meridian-action-button--outline"
          }
          disabled={model.isUnderway}
          onClick={model.start}
        >
          {actionLabel}
        </button>
      </div>
      {model.startRefusal === undefined ? null : (
        <InlineRefusal
          code={model.startRefusal.code}
          detail={model.startRefusal.detail}
          onTryAgain={model.start}
        />
      )}
      {/* The panel may open behind a disclosure: what its row says as it opens stands. */}
      <StandingContent>
        <ImportProgressLine model={model} />
      </StandingContent>
    </section>
  );
}
