// The one progress row a provider's import reports into, in the service's own counts.
//
// While an import runs the row counts what it has read and carries `Stop`, over a bar that moves
// but measures nothing; once it ends the row says how it ended, and where conversations failed
// or files could not be read, pressing the row unfolds them. The counts read, imported, total and
// already here, and the names of attached projects, are the service's own and drawn as wire
// figures; the failed and unreadable counts are the row's own tallies of the lists the service
// sent, and their clauses draw in the failure red and the attention amber. A filled bar or
// percentage would invent a denominator nobody sent.

import { Collapsible } from "@base-ui/react/collapsible";
import { useMemo } from "react";

import type { ProviderImportOutcome } from "@ai-sidekicks/contracts/provider/import";
import { PROVIDER_LABELS } from "@ai-sidekicks/contracts/provider/name";
import { InlineRefusal } from "#renderer/components/Refusal/InlineRefusal.js";
import { FigureSentence } from "#renderer/components/FigureSentence/FigureSentence.js";
import { WireFigure } from "#renderer/components/WireFigure/WireFigure.js";
import { joinFigureSentence, type FigureSentencePart } from "#renderer/lib/figure-sentence.js";
import { formatCount, formatWireString } from "#renderer/lib/wire/figures.js";
import { useAnnounceWhenChanged } from "#renderer/hooks/announce/useAnnounceWhenChanged.js";
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
  // The row speaks through the app's announcer; a refused row's refusal speaks for itself. A
  // running import is said once, without the count it redraws on every frame, which would
  // otherwise be read out frame by frame. What the stream replayed as it opened is not news; a
  // new press is, even where its words match the last press's.
  const { isUnderway } = model;
  const { sentence, announcement } = useMemo(() => {
    const rowWords = rowSentence(progress, isUnderway, providerLabel);
    return {
      sentence: rowWords,
      announcement:
        isUnderway && progress.status !== "failed"
          ? importingWords(providerLabel)
          : rowWords === undefined
            ? undefined
            : joinFigureSentence(rowWords),
    };
  }, [isUnderway, progress, providerLabel]);
  useAnnounceWhenChanged(announcement, "polite", {
    attempt: model.startPressOrdinal,
    isStanding: model.isShowingReplay,
  });
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
        <span>{sentence === undefined ? null : <FigureSentence parts={sentence} />}</span>
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
        isStanding={model.isShowingReplay}
      />
    );
  }
  if (settlement.outcome === "stopped") {
    return <p className={PROGRESS_CLASS}>{IMPORT_STOPPED_SENTENCE}</p>;
  }
  return <SettledLine settlement={settlement} providerLabel={providerLabel} />;
}

/** What a stopped import's row says. */
const IMPORT_STOPPED_SENTENCE =
  "Import stopped. The sessions already read are in the sessions list.";

function importingWords(providerLabel: string): string {
  return `Importing from ${providerLabel}…`;
}

/**
 * The words the row shows where they are the row's own: while an import runs, once it stopped,
 * and once it settled. `undefined` where the row is a refusal or draws nothing.
 */
function rowSentence(
  progress: ProviderImportModel["progress"],
  isUnderway: boolean,
  providerLabel: string,
): readonly FigureSentencePart[] | undefined {
  if (progress.status === "failed") {
    return undefined;
  }
  const { newest } = progress;
  if (isUnderway) {
    const words = importingWords(providerLabel);
    return newest?.kind === "progress"
      ? [`${words} `, { wire: formatCount(newest.read) }, " read."]
      : [words];
  }
  if (newest?.kind !== "settled" || newest.settlement.outcome === "refused") {
    return undefined;
  }
  if (newest.settlement.outcome === "stopped") {
    return [IMPORT_STOPPED_SENTENCE];
  }
  return settledClauses(newest.settlement, providerLabel).flatMap((clause) => clause.parts);
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
  // One flex item, so the row's gap never stands in for a space between the line's words.
  const line = (
    <span>
      {settledClauses(settlement, providerLabel).map((clause, index) =>
        clause.tone === undefined ? (
          <FigureSentence key={index} parts={clause.parts} />
        ) : (
          <span key={index} className={SETTLED_CLAUSE_TONE_CLASSES[clause.tone]}>
            <FigureSentence parts={clause.parts} />
          </span>
        ),
      )}
    </span>
  );
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

/** One stretch of the settled line, drawn in the hue its tone names where it has one. */
interface SettledClause {
  readonly parts: readonly FigureSentencePart[];
  readonly tone?: "failure" | "attention";
}

/** The class each toned clause wears. */
const SETTLED_CLAUSE_TONE_CLASSES: Readonly<Record<NonNullable<SettledClause["tone"]>, string>> = {
  failure: "meridian-provider-import__clause--failure",
  attention: "meridian-provider-import__clause--attention",
};

/**
 * How an import that found sessions, or found nothing new, ended, then the projects it attached,
 * each part only where there is one, as the line's clauses.
 */
function settledClauses(
  settlement: Extract<ProviderImportOutcome, { outcome: "finished" | "nothingNew" }>,
  providerLabel: string,
): readonly SettledClause[] {
  const head: readonly FigureSentencePart[] =
    settlement.outcome === "nothingNew"
      ? [`Nothing new to import from ${providerLabel}`]
      : [
          "Imported ",
          ...importedCount(settlement.imported, settlement.total),
          ` from ${providerLabel}`,
        ];
  const failureCount = settlement.outcome === "finished" ? settlement.failures.length : 0;
  const attachedProjects = settlement.outcome === "finished" ? settlement.attachedProjects : [];
  const unreadableCount = settlement.unreadableFiles.length;
  const clauses: readonly SettledClause[] = [
    { parts: head },
    ...(settlement.alreadyHere === 0
      ? []
      : [{ parts: [{ wire: formatCount(settlement.alreadyHere) }, " already here"] }]),
    ...(failureCount === 0
      ? []
      : [{ parts: [`${formatCount(failureCount)} failed`], tone: "failure" as const }]),
    ...(unreadableCount === 0
      ? []
      : [
          {
            parts: [
              `${formatCount(unreadableCount)} ${unreadableCount === 1 ? "file" : "files"} ` +
                "could not be read",
            ],
            tone: "attention" as const,
          },
        ]),
    ...(attachedProjects.length === 0
      ? []
      : [
          {
            parts: [
              "attached ",
              ...attachedProjects.flatMap((project, index) => [
                ...(index === 0 ? [] : [", "]),
                { wire: project },
              ]),
            ],
          },
        ]),
  ];
  // Each clause carries its own separator and the last the full stop, so a toned clause's hue
  // reaches its separator and no element boundary falls inside the sentence's punctuation.
  return clauses.map((clause, index) => ({
    ...clause,
    parts: [
      ...(index === 0 ? [] : [" · "]),
      ...clause.parts,
      ...(index === clauses.length - 1 ? ["."] : []),
    ],
  }));
}

/** `125 of 128 sessions`, or `12 sessions` where every session read was imported. */
function importedCount(imported: number, total: number): readonly FigureSentencePart[] {
  return imported === total
    ? sessionCount(imported)
    : [{ wire: formatCount(imported) }, " of ", ...sessionCount(total)];
}

/** A count the service sent and `session` agreeing with it. */
function sessionCount(count: number): readonly FigureSentencePart[] {
  return [{ wire: formatCount(count) }, count === 1 ? " session" : " sessions"];
}
