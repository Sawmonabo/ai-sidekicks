// The one progress row a provider's import reports into, in the service's own counts.
//
// While an import runs the row counts what it has read and carries `Stop`, over a bar that moves
// but measures nothing; once it ends the row says how it ended, and where conversations failed
// or files could not be read, pressing the row unfolds them. The refusal and most counts are the
// service's own and drawn as wire figures. The failed and unreadable counts are the row's own
// tallies of the lists the service sent, drawn as derived figures. A filled bar or percentage
// would invent a denominator nobody sent.

import { Collapsible } from "@base-ui/react/collapsible";

import type { ProviderImportOutcome } from "@ai-sidekicks/contracts/provider/import";
import { InlineRefusal } from "#renderer/components/Refusal/InlineRefusal.js";
import { DerivedFigure } from "#renderer/components/DerivedFigure/DerivedFigure.js";
import { WireFigure } from "#renderer/components/WireFigure/WireFigure.js";
import { PROVIDER_LABELS } from "@ai-sidekicks/contracts/provider/name";
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
  const sentence = rowSentence(model, providerLabel);
  useAnnounceWhenChanged(
    model.isUnderway && progress.status !== "failed"
      ? importingWords(providerLabel)
      : sentence === undefined
        ? undefined
        : sentenceText(sentence),
    "polite",
    { attempt: model.startPressOrdinal, isStanding: model.isShowingReplay },
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
        <span>{sentence === undefined ? null : <Sentence parts={sentence} />}</span>
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

/**
 * One stretch of a row's sentence: words, a count or name the service sent, drawn as a wire
 * figure, or a count the row made by counting what the service sent, drawn as the app's own.
 */
type SentencePart = string | { readonly wire: string } | { readonly derived: string };

/** A sentence's words as one string, for the announcer. */
function sentenceText(parts: readonly SentencePart[]): string {
  return parts
    .map((part) => (typeof part === "string" ? part : "wire" in part ? part.wire : part.derived))
    .join("");
}

/** A sentence drawn with each figure in its own figure class. */
function Sentence(props: { readonly parts: readonly SentencePart[] }): React.JSX.Element {
  return (
    <>
      {props.parts.map((part, index) =>
        typeof part === "string" ? (
          part
        ) : "wire" in part ? (
          <WireFigure key={index} value={part.wire} />
        ) : (
          <DerivedFigure key={index} text={part.derived} />
        ),
      )}
    </>
  );
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
  model: ProviderImportModel,
  providerLabel: string,
): readonly SentencePart[] | undefined {
  const { progress } = model;
  if (progress.status === "failed") {
    return undefined;
  }
  const { newest } = progress;
  if (model.isUnderway) {
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
  const line = <Sentence parts={settledSentence(settlement, providerLabel)} />;
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
): readonly SentencePart[] {
  const head: readonly SentencePart[] =
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
  const clauses: (readonly SentencePart[])[] = [
    ...(settlement.alreadyHere === 0
      ? []
      : [[{ wire: formatCount(settlement.alreadyHere) }, " already here"]]),
    ...(failureCount === 0 ? [] : [[{ derived: formatCount(failureCount) }, " failed"]]),
    ...(unreadableCount === 0
      ? []
      : [
          [
            { derived: formatCount(unreadableCount) },
            ` ${unreadableCount === 1 ? "file" : "files"} could not be read`,
          ],
        ]),
    ...(attachedProjects.length === 0
      ? []
      : [
          [
            "attached ",
            ...attachedProjects.flatMap((project, index) => [
              ...(index === 0 ? [] : [", "]),
              { wire: project },
            ]),
          ],
        ]),
  ];
  return [
    ...[head, ...clauses].flatMap((clause, index) => [...(index === 0 ? [] : [" · "]), ...clause]),
    ".",
  ];
}

/** `125 of 128 sessions`, or `12 sessions` where every session read was imported. */
function importedCount(imported: number, total: number): readonly SentencePart[] {
  return imported === total
    ? sessionCount(imported)
    : [{ wire: formatCount(imported) }, " of ", ...sessionCount(total)];
}

/** A count the service sent and `session` agreeing with it. */
function sessionCount(count: number): readonly SentencePart[] {
  return [{ wire: formatCount(count) }, count === 1 ? " session" : " sessions"];
}
