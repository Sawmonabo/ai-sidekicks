// The one progress row a provider's import reports into, in the service's own counts.
//
// While an import runs the row counts what it has read and carries `Stop`, over a bar that moves
// but measures nothing; once it ends the row says how it ended, and where conversations failed
// or files could not be read, pressing the row unfolds them. Nothing is computed from the
// messages: the counts and the refusal are the service's own, and a filled bar or percentage
// would invent a denominator nobody sent.

import { Collapsible } from "@base-ui/react/collapsible";

import type { ProviderImportOutcome } from "@ai-sidekicks/contracts/provider/import";
import { InlineRefusal } from "#renderer/components/Refusal/InlineRefusal.js";
import { WireFigure } from "#renderer/components/WireFigure/WireFigure.js";
import { PROVIDER_LABELS } from "@ai-sidekicks/contracts/provider/name";
import { formatCount, formatWireString } from "#renderer/lib/wire/figures.js";
import { useAnnounceWhenShown } from "#renderer/hooks/announce/useAnnounceWhenShown.js";
import type { ProviderImportModel } from "../hooks/useProviderImport.js";

/** What the progress row draws: one provider's import. */
export interface ImportProgressLineProps {
  readonly model: ProviderImportModel;
}

/** The code a refused import's line carries; the reason is the service's own words. */
const IMPORT_REFUSED_CODE = "import-refused";

/** The class every state of the row wears. */
const PROGRESS_CLASS = "meridian-provider-import__progress";

/** What a stopped import's row says. */
const IMPORT_STOPPED_SENTENCE =
  "Import stopped. The sessions already read are in the sessions list.";

/** One provider's import row, or nothing where the service has reported none. */
export function ImportProgressLine(props: ImportProgressLineProps): React.JSX.Element | null {
  const { model } = props;
  const { progress } = model;
  const providerLabel = PROVIDER_LABELS[model.provider];
  // The row mounts holding its words, so it speaks them through the app's announcer; a refused
  // row's refusal speaks for itself. A running import is said once, without the count it
  // redraws on every frame, which would otherwise be read out frame by frame.
  const sentence = rowSentence(model, providerLabel);
  useAnnounceWhenShown(
    model.isUnderway && progress.status !== "failed" ? importingWords(providerLabel) : sentence,
    "polite",
  );
  if (progress.status === "failed") {
    return (
      <InlineRefusal
        code={progress.refusal.code}
        detail={progress.refusal.detail}
        onTryAgain={model.reopen}
        attempt={progress.refusal}
      />
    );
  }
  const { newest } = progress;
  if (model.isUnderway) {
    return (
      <div className={PROGRESS_CLASS}>
        <span>{sentence}</span>
        {model.isReading ? (
          <button
            type="button"
            className={
              "meridian-action-button meridian-action-button--small " +
              "meridian-action-button--outline"
            }
            disabled={model.isStopping}
            onClick={model.stop}
          >
            Stop
          </button>
        ) : null}
        {/* No value: the stream sends no total, so the bar is indeterminate. */}
        <progress
          className="meridian-provider-import__bar"
          aria-label={`Importing from ${providerLabel}`}
        />
        {model.stopRefusal === undefined ? null : (
          <InlineRefusal code={model.stopRefusal.code} detail={model.stopRefusal.detail} />
        )}
      </div>
    );
  }
  if (newest?.kind !== "settled") {
    return null;
  }
  const { settlement } = newest;
  if (settlement.outcome === "refused") {
    return (
      <InlineRefusal
        code={IMPORT_REFUSED_CODE}
        detail={settlement.reason}
        onTryAgain={model.start}
      />
    );
  }
  if (settlement.outcome === "stopped") {
    return <p className={PROGRESS_CLASS}>{IMPORT_STOPPED_SENTENCE}</p>;
  }
  return <SettledLine settlement={settlement} providerLabel={providerLabel} />;
}

function importingWords(providerLabel: string): string {
  return `Importing from ${providerLabel}…`;
}

/**
 * The words the row shows where they are the row's own: while an import runs, once it stopped,
 * and once it settled. `undefined` where the row is a refusal or draws nothing.
 */
function rowSentence(model: ProviderImportModel, providerLabel: string): string | undefined {
  const { progress } = model;
  if (progress.status === "failed") {
    return undefined;
  }
  const { newest } = progress;
  if (model.isUnderway) {
    const count = newest?.kind === "progress" ? ` ${formatCount(newest.read)} read.` : "";
    return `${importingWords(providerLabel)}${count}`;
  }
  if (newest?.kind !== "settled" || newest.settlement.outcome === "refused") {
    return undefined;
  }
  if (newest.settlement.outcome === "stopped") {
    return IMPORT_STOPPED_SENTENCE;
  }
  return settledSentence(newest.settlement, providerLabel);
}

/**
 * A finished import, or one that found nothing new: the line with every count the service sent,
 * and, where conversations failed or files could not be read, a press that unfolds them.
 */
function SettledLine(props: {
  readonly settlement: Extract<ProviderImportOutcome, { outcome: "finished" | "nothingNew" }>;
  readonly providerLabel: string;
}): React.JSX.Element {
  const { settlement, providerLabel } = props;
  const failures = settlement.outcome === "finished" ? settlement.failures : [];
  const line = settledSentence(settlement, providerLabel);
  if (failures.length === 0 && settlement.unreadableFiles.length === 0) {
    return <p className={PROGRESS_CLASS}>{line}</p>;
  }
  return (
    <Collapsible.Root className={PROGRESS_CLASS}>
      <Collapsible.Trigger className="meridian-disclosure-trigger">{line}</Collapsible.Trigger>
      <Collapsible.Panel className="meridian-provider-import__unfolded">
        <ul className="meridian-provider-import__unfolded-list">
          {failures.map((failure) => (
            <li key={failure.source}>
              <WireFigure value={failure.source} /> {formatWireString(failure.reason)}
            </li>
          ))}
          {settlement.unreadableFiles.map((path) => (
            <li key={path}>
              <WireFigure value={path} />
            </li>
          ))}
        </ul>
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}

/**
 * How an import that found sessions, or found nothing new, ended, then the projects it attached;
 * each part only where there is one.
 */
function settledSentence(
  settlement: Extract<ProviderImportOutcome, { outcome: "finished" | "nothingNew" }>,
  providerLabel: string,
): string {
  const head =
    settlement.outcome === "nothingNew"
      ? `Nothing new to import from ${providerLabel}`
      : `Imported ${importedCount(settlement.imported, settlement.total)} from ${providerLabel}`;
  const failureCount = settlement.outcome === "finished" ? settlement.failures.length : 0;
  const attachedProjects = settlement.outcome === "finished" ? settlement.attachedProjects : [];
  const clauses = [
    ...(settlement.alreadyHere === 0
      ? []
      : [`${formatCount(settlement.alreadyHere)} already here`]),
    ...(failureCount === 0 ? [] : [`${formatCount(failureCount)} failed`]),
    ...(settlement.unreadableFiles.length === 0
      ? []
      : [`${countOf(settlement.unreadableFiles.length, "file", "files")} could not be read`]),
    ...(attachedProjects.length === 0
      ? []
      : [`attached ${attachedProjects.map(formatWireString).join(", ")}`]),
  ];
  return `${[head, ...clauses].join(" · ")}.`;
}

/** `125 of 128 sessions`, or `12 sessions` where every session read was imported. */
function importedCount(imported: number, total: number): string {
  return imported === total
    ? countOf(imported, "session", "sessions")
    : `${formatCount(imported)} of ${countOf(total, "session", "sessions")}`;
}

/** A figure and its noun, agreeing. */
function countOf(count: number, singular: string, plural: string): string {
  return `${formatCount(count)} ${count === 1 ? singular : plural}`;
}
