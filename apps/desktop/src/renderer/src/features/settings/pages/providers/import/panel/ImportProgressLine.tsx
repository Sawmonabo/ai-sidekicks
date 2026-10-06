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
import { TryAgainButton } from "#renderer/components/TryAgainButton/TryAgainButton.js";
import { WireFigure } from "#renderer/components/WireFigure/WireFigure.js";
import { PROVIDER_LABELS } from "@ai-sidekicks/contracts/provider/name";
import { formatCount, formatWireString } from "#renderer/lib/wire/figures.js";
import type { ProviderImportModel } from "../hooks/useProviderImport.js";

/** What the progress row draws: one provider's import. */
export interface ImportProgressLineProps {
  readonly model: ProviderImportModel;
}

/** The code a refused import's line carries; the reason is the service's own words. */
const IMPORT_REFUSED_CODE = "import-refused";

/** The class every state of the row wears. */
const PROGRESS_CLASS = "meridian-provider-import__progress";

/** One provider's import row, or nothing where the service has reported none. */
export function ImportProgressLine(props: ImportProgressLineProps): React.JSX.Element | null {
  const { model } = props;
  const { progress } = model;
  const providerLabel = PROVIDER_LABELS[model.provider];
  if (progress.status === "failed") {
    return (
      <InlineRefusal
        code={progress.refusal.code}
        detail={progress.refusal.detail}
        action={<TryAgainButton onPress={model.reopen} />}
      />
    );
  }
  const { newest } = progress;
  if (model.isUnderway) {
    return (
      <div className={PROGRESS_CLASS} role="status">
        <span>
          {`Importing from ${providerLabel}…`}
          {newest?.kind === "progress" ? ` ${formatCount(newest.read)} read.` : null}
        </span>
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
        action={<TryAgainButton onPress={model.start} />}
      />
    );
  }
  if (settlement.outcome === "stopped") {
    return (
      <p className={PROGRESS_CLASS} role="status">
        Import stopped. The sessions already read are in the sessions list.
      </p>
    );
  }
  return <SettledLine settlement={settlement} providerLabel={providerLabel} />;
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
    return (
      <p className={PROGRESS_CLASS} role="status">
        {line}
      </p>
    );
  }
  return (
    <Collapsible.Root className={PROGRESS_CLASS} role="status">
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
