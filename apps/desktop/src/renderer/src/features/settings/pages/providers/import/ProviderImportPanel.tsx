// Bring a provider transcript in as a session.
//
// A person already has Claude Code or Codex conversations on disk and wants them here
// rather than retyped. The panel is a form over one choice, the provider, and the
// import it starts.
//
// THE START IS NOT WHERE IT ENDS. The act settles the moment the daemon hands back an
// import id, which is the moment the READING starts rather than the moment it
// finishes. A control re-enabled there lets a second submit move the panel's stream to
// another provider and leave the first import running with nothing on screen reporting
// it — so what disables the control is the whole of the import, the start and the
// stream that follows it, and the two phases keep their own sentences.
//
// THE IMPORT ITSELF IS NOT HELD HERE, AND THAT IS DELIBERATE. This panel may be
// rendered behind a disclosure, so anything it held would end the moment somebody
// looked elsewhere — a closed progress stream, a lost import id, and the guard above
// bypassed on the way back. `useProviderImport.ts` says the rest; what matters here is
// that this component is a VIEW over an import and never the place one lives. The
// provider choice is the exception and is correctly the panel's: it is what the NEXT
// import will be, and a person who has left the form has not chosen one yet.

import "./provider-import.css";

import { useMemo, useState } from "react";

import { PROVIDER_NAMES, type ProviderName } from "@ai-sidekicks/contracts";

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
  const { progress, isBeginning, isReading, isUnderway } = model;

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
      className="meridian-session-import"
      aria-label="Import a provider session"
      onSubmit={(event) => {
        event.preventDefault();
        if (disabledReason !== undefined || provider === undefined) {
          return;
        }
        void model.put({ provider });
      }}
    >
      <p className="meridian-session-import__lede">
        Read a provider's existing conversations into sessions.
      </p>
      <label className="meridian-session-import__field">
        <span className="meridian-session-import__label">Provider</span>
        <select
          className="meridian-session-import__input"
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
        className="meridian-session-import__submit meridian-action-button meridian-action-button--regular meridian-action-button--outline"
        disabled={disabledReason !== undefined}
        title={disabledReason}
      >
        {importSubmitLabel(isBeginning, isReading)}
      </button>
      {disabledReason === undefined ? null : (
        <p className="meridian-session-import__blocked">{disabledReason}</p>
      )}
      <ImportProgressLine progress={progress} />
    </form>
  );
}

/**
 * What the control says about the phase the import is in.
 *
 * Three labels and not two: the button would have read "Starting…" for the whole of
 * an import once the disabled predicate grew the stream, which names the one phase
 * that has already finished. The progress line below says what the PRODUCER has
 * counted; this says which of the panel's two calls is outstanding.
 */
function importSubmitLabel(isBeginning: boolean, isReading: boolean): string {
  if (isBeginning) {
    return "Starting…";
  }
  return isReading ? "Reading…" : "Import";
}
