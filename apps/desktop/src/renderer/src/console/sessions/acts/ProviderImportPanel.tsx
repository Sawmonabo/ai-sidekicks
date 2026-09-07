// Bring a provider transcript in as a session.
//
// The third way work arrives at this destination, after starting one and joining one:
// a person already has a Claude or Codex thread on disk and wants it here rather than
// retyped. It is reached from the create menu rather than sitting open, because it is
// the least common of the three and an always-open form beside two buttons reads as
// the primary act.
//
// IT IS BUILT ON THE GROWTH PORT AND SAYS SO. `providerSessionImportBegin` and
// `providerSessionImportSubscribe` are on `Plan-023 §Console growth slate` under the
// `provider-session-import` row, owned by a spec that does not exist yet. Against the
// live bridge both refuse `wire-unregistered`, and the refusal names the document that
// owes the wire — so the panel renders the console's honest "nobody asked" rather than
// a form that silently does nothing.
//
// TWO CALLS, TWO RENDERINGS. The begin settles once and its arms are the act's; the
// subscription is a stream and its arms are its own. They are rendered in sequence
// rather than merged, because a person watching an import wants to know which half is
// running: a refusal from the begin means nothing started, and one from the stream
// means something did and then stopped.
//
// ONE IMPORT AT A TIME, AND THE BEGIN IS NOT WHERE IT ENDS. The act settles the
// moment the daemon hands back an import id, which is the moment the READING starts
// rather than the moment it finishes. A control re-enabled there lets a second submit
// replace the id, close the first subscription, and leave that import running with
// nothing on screen reporting it — so what disables the control is the whole of the
// import, the begin and the stream that follows it, and the two phases keep their own
// sentences because they fail differently.

import { useMemo, useState } from "react";

import { SessionAct, useSessionAct } from "./act-settlement.js";
import { isImportUnderway, useImportProgress } from "./provider-import.js";
import { ImportProgressLine } from "./ImportProgressLine.js";
import { InlineRefusal } from "../../primitives/index.js";
import { settleGrowthRead, type GrowthPort } from "../../bridge/index.js";
import { useSubjectScopedState } from "../../store/index.js";

/** The holder key the import's opening act is addressed by, within a port. */
const IMPORT_ACT_KEY = "provider-session-import";

export interface ProviderImportPanelProps {
  readonly growth: GrowthPort;
  /** Why the import cannot be started, or `undefined` where it can. */
  readonly blockedReason?: string | undefined;
}

export function ProviderImportPanel(props: ProviderImportPanelProps): React.JSX.Element {
  const { growth, blockedReason } = props;
  const [providerName, setProviderName] = useState("");
  const [sourceRef, setSourceRef] = useState("");
  // Keyed on the PORT, on the rule `JoinSessionForm.tsx` states: an act minted in a
  // mount-lifetime cell stays bound to the growth port the window closed when the
  // bridge or the scenario moved.
  const begin = useSubjectScopedState(
    growth,
    IMPORT_ACT_KEY,
    () =>
      new SessionAct<{ providerName: string; sourceRef: string }, { importId: string }>({
        // Through `settleGrowthRead`, which is the console's one reader of a growth
        // call that REJECTED rather than answering — the fixture throws a scripted
        // daemon refusal verbatim, and the live seam will throw the same shape the day
        // the wire lands, so a call site reading only the fulfilment arm leaves the
        // form pinned on "running" for the life of the mount while an unhandled
        // rejection reaches the window.
        //
        // The refusing arm IS a `ConsoleRefusal` either way and carries the operation,
        // the slate row, and the document that owes the wire, so it travels onto the
        // act's refused arm untouched rather than being re-minted here.
        attempt: async (request) => {
          const outcome = await settleGrowthRead(growth.providerSessionImportBegin(request));
          return outcome.status === "served"
            ? { status: "served", value: outcome.value }
            : { status: "refused", refusal: outcome };
        },
        describeWhat: "The import",
      }),
  ).value;
  const settlement = useSessionAct(begin);
  const importId = settlement.status === "settled" ? settlement.answer.importId : undefined;
  const progress = useImportProgress(growth, importId);

  const trimmedProviderName = providerName.trim();
  const trimmedSourceRef = sourceRef.trim();
  const isBeginning = settlement.status === "running";
  const isReading = isImportUnderway(importId, progress);
  const isRunning = isBeginning || isReading;
  const isIncomplete = trimmedProviderName.length === 0 || trimmedSourceRef.length === 0;
  const disabledReason = useMemo(() => {
    if (blockedReason !== undefined) {
      return blockedReason;
    }
    if (isBeginning) {
      return "The last import is still starting.";
    }
    if (isReading) {
      return "The last import is still being read.";
    }
    return isIncomplete ? "Both the provider and what to read are needed." : undefined;
  }, [blockedReason, isBeginning, isReading, isIncomplete]);

  return (
    <form
      className="meridian-session-import"
      aria-label="Import a provider session"
      onSubmit={(event) => {
        event.preventDefault();
        if (disabledReason !== undefined) {
          return;
        }
        void begin.run({ providerName: trimmedProviderName, sourceRef: trimmedSourceRef });
      }}
    >
      <p className="meridian-session-import__lede">
        Read an existing provider thread into a session. The ingest is on the growth slate — where
        it is refused, nothing was asked and the refusal names who owes the wire.
      </p>
      <label className="meridian-session-import__field">
        <span className="meridian-session-import__label">Provider</span>
        <input
          className="meridian-session-import__input"
          value={providerName}
          disabled={isRunning}
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
          disabled={isRunning}
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
      {settlement.status === "refused" ? <InlineRefusal {...settlement.refusal} /> : null}
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
