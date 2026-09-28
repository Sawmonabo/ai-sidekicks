// Bring a provider transcript in as a session.
//
// A person already has a Claude or Codex thread on disk and wants it here rather than
// retyped. The panel is a form over two fields and one import.
//
// ONE IMPORT AT A TIME, AND THE BEGIN IS NOT WHERE IT ENDS. The act settles the
// moment the daemon hands back an import id, which is the moment the READING starts
// rather than the moment it finishes. A control re-enabled there lets a second submit
// replace the id, close the first subscription, and leave that import running with
// nothing on screen reporting it — so what disables the control is the whole of the
// import, the begin and the stream that follows it, and the two phases keep their own
// sentences.
//
// THE IMPORT ITSELF IS NOT HELD HERE, AND THAT IS DELIBERATE. This panel may be
// rendered behind a disclosure, so anything it held would end the moment somebody
// looked elsewhere — a closed progress stream, a lost import id, and the guard above
// bypassed on the way back. `provider-import-model.ts` says the rest; what matters
// here is that this component is a VIEW over an import and never the place one lives.
// The two fields are the exception and are correctly the panel's: they are what the
// NEXT import will be, and a person who has left the form has not typed one yet.

import { useMemo, useState } from "react";

import { ImportProgressLine } from "./ImportProgressLine.js";
import type { ProviderImportModel } from "./provider-import-model.js";

/** What the panel draws: the import its caller is holding, running or not. */
export interface ProviderImportPanelProps {
  readonly model: ProviderImportModel;
}

/** The form that puts one provider import, and the progress line that reports it. */
export function ProviderImportPanel(props: ProviderImportPanelProps): React.JSX.Element {
  const { model } = props;
  const [providerName, setProviderName] = useState("");
  const [sourceRef, setSourceRef] = useState("");
  const { progress, isBeginning, isReading, isUnderway } = model;

  const trimmedProviderName = providerName.trim();
  const trimmedSourceRef = sourceRef.trim();
  const isIncomplete = trimmedProviderName.length === 0 || trimmedSourceRef.length === 0;
  const disabledReason = useMemo(() => {
    if (isBeginning) {
      return "The last import is still starting.";
    }
    if (isReading) {
      return "The last import is still being read.";
    }
    return isIncomplete ? "Both the provider and what to read are needed." : undefined;
  }, [isBeginning, isReading, isIncomplete]);

  return (
    <form
      className="meridian-session-import"
      aria-label="Import a provider session"
      onSubmit={(event) => {
        event.preventDefault();
        if (disabledReason !== undefined) {
          return;
        }
        void model.put({ providerName: trimmedProviderName, sourceRef: trimmedSourceRef });
      }}
    >
      <p className="meridian-session-import__lede">
        Read an existing provider thread into a session.
      </p>
      <label className="meridian-session-import__field">
        <span className="meridian-session-import__label">Provider</span>
        <input
          className="meridian-session-import__input"
          value={providerName}
          disabled={isUnderway}
          placeholder="claude"
          onChange={(event) => {
            setProviderName(event.target.value);
          }}
        />
      </label>
      <label className="meridian-session-import__field">
        <span className="meridian-session-import__label">What to read</span>
        <input
          className="meridian-session-import__input"
          value={sourceRef}
          disabled={isUnderway}
          placeholder="The transcript this node can reach"
          onChange={(event) => {
            setSourceRef(event.target.value);
          }}
        />
      </label>
      <button
        type="submit"
        className="meridian-session-import__submit"
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
