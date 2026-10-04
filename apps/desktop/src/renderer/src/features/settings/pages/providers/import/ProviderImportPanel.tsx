// Bring a provider transcript in as a session: a form over one choice, the provider, and
// the import it starts.
//
// The start settles when the daemon hands back an import id, which is when reading begins,
// not when it finishes. The control stays disabled through the start and the stream that
// follows, so a second submit cannot move the stream to another provider and leave the
// first import running unreported.
//
// The import itself lives in `useProviderImport.ts`, not here: this panel may sit behind a
// disclosure, and anything it held would end when the disclosure closed. Only the provider
// choice is the panel's, since it is what the next import will be.

import "./provider-import.css";

import { useMemo, useState } from "react";

import { PROVIDER_NAMES, type ProviderName } from "@ai-sidekicks/contracts/provider-account";

import { InlineRefusal } from "@renderer/components/Refusal/InlineRefusal.js";
import { ImportProgressLine } from "./ImportProgressLine.js";
import type { ProviderImportModel } from "./useProviderImport.js";

/** What the panel draws: the import its caller is holding, running or not. */
export interface ProviderImportPanelProps {
  readonly model: ProviderImportModel;
}

/** The form that puts one provider import, and the progress line that reports it. */
export function ProviderImportPanel(props: ProviderImportPanelProps): React.JSX.Element {
  const { model } = props;
  const [provider, setProvider] = useState<ProviderName | undefined>(undefined);
  const { progress, isBeginning, startRefusal, isReading, isUnderway } = model;

  const disabledReason = useMemo(() => {
    if (isBeginning) {
      return "The last import is still starting.";
    }
    if (isReading) {
      return "The last import is still being read.";
    }
    return provider === undefined ? "Choose the provider to import from." : undefined;
  }, [isBeginning, isReading, provider]);

  return (
    <form
      className="meridian-provider-import"
      aria-label="Import a provider session"
      onSubmit={(event) => {
        event.preventDefault();
        if (disabledReason !== undefined || provider === undefined) {
          return;
        }
        void model.put({ provider });
      }}
    >
      <p className="meridian-provider-import__lede">
        Read a provider's existing conversations into sessions.
      </p>
      <label className="meridian-provider-import__field">
        <span className="meridian-provider-import__label">Provider</span>
        <select
          className="meridian-provider-import__input"
          value={provider ?? ""}
          disabled={isUnderway}
          onChange={(event) => {
            setProvider(PROVIDER_NAMES.find((name) => name === event.target.value));
          }}
        >
          <option value="">Choose a provider</option>
          {PROVIDER_NAMES.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </label>
      <button
        type="submit"
        className={
          "meridian-provider-import__submit meridian-action-button " +
          "meridian-action-button--regular meridian-action-button--outline"
        }
        disabled={disabledReason !== undefined}
        title={disabledReason}
      >
        {importSubmitLabel(isBeginning, isReading)}
      </button>
      {disabledReason === undefined ? null : (
        <p className="meridian-provider-import__blocked">{disabledReason}</p>
      )}
      {startRefusal === undefined ? null : (
        <InlineRefusal code={startRefusal.code} detail={startRefusal.detail} />
      )}
      <ImportProgressLine progress={progress} />
    </form>
  );
}

/**
 * What the control says about the phase the import is in.
 *
 * Three labels, not two: "Starting…" would otherwise show for the whole import, though the
 * start has finished. The progress line reports what the producer has counted; this names
 * the call still outstanding.
 */
function importSubmitLabel(isBeginning: boolean, isReading: boolean): string {
  if (isBeginning) {
    return "Starting…";
  }
  return isReading ? "Reading…" : "Import";
}
