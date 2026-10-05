// What one provider's import stream has said, in its own words.
//
// Every arm renders: an open stream that has not spoken is "nothing counted yet", a closed
// one that never spoke ended having said nothing, and each way an import ends has its own
// sentence. Nothing is computed from the messages: the counts and the refusal are the
// service's own, and a percentage would invent a denominator nobody sent.

import type { ProviderImportOutcome } from "@ai-sidekicks/contracts/provider/import";
import { InlineRefusal } from "#renderer/components/Refusal/InlineRefusal.js";
import { WireFigure } from "#renderer/components/WireFigure/WireFigure.js";
import { formatCount } from "#renderer/lib/wire/figures.js";
import type { ImportProgressReading } from "./progress.js";

/** What the progress line draws: one provider's import reading. */
export interface ImportProgressLineProps {
  readonly progress: ImportProgressReading;
}

/** One provider's import, or nothing where no stream has been asked for. */
export function ImportProgressLine(props: ImportProgressLineProps): React.JSX.Element | null {
  const { progress } = props;
  if (progress.status === "unsubscribed") {
    return null;
  }
  if (progress.status === "failed") {
    return <InlineRefusal code={progress.refusal.code} detail={progress.refusal.detail} />;
  }
  const { newest } = progress;
  if (newest === undefined) {
    return (
      <p className="meridian-provider-import__progress" aria-live="polite">
        {progress.status === "open"
          ? "Reading. Nothing counted yet."
          : "The import ended without reporting anything."}
      </p>
    );
  }
  if (newest.kind === "progress") {
    return (
      <p className="meridian-provider-import__progress" aria-live="polite">
        Reading — {countOf(newest.read, "conversation", "conversations")} read so far.
      </p>
    );
  }
  const { settlement } = newest;
  return (
    <p className="meridian-provider-import__progress" aria-live="polite">
      {settlement.outcome === "refused" ? (
        <>
          The last import was refused: <WireFigure value={settlement.reason} />
        </>
      ) : (
        settledSentence(settlement)
      )}
    </p>
  );
}

/** How an import that was not refused ended, with every figure the service sent. */
function settledSentence(
  settlement: Exclude<ProviderImportOutcome, { outcome: "refused" }>,
): string {
  switch (settlement.outcome) {
    case "finished":
      return [
        `The last import brought in ${formatCount(settlement.imported)} ` +
          "of " +
          `${countOf(settlement.total, "conversation", "conversations")}; ` +
          `${formatCount(settlement.alreadyHere)} already here.`,
        ...failureClauses(settlement.failures.length, settlement.unreadableFiles.length),
        ...(settlement.attachedProjects.length === 0
          ? []
          : [`Attached ${countOf(settlement.attachedProjects.length, "project", "projects")}.`]),
      ].join(" ");
    case "nothingNew":
      return [
        `The last import found nothing new; ${formatCount(settlement.alreadyHere)} already here.`,
        ...failureClauses(0, settlement.unreadableFiles.length),
      ].join(" ");
    case "stopped":
      return "The last import was stopped. The conversations already read stay in the list.";
  }
}

/** The failures an ended import reports, one clause each, and none where there were none. */
function failureClauses(failureCount: number, unreadableFileCount: number): readonly string[] {
  return [
    ...(failureCount === 0
      ? []
      : [`${countOf(failureCount, "conversation", "conversations")} could not be imported.`]),
    ...(unreadableFileCount === 0
      ? []
      : [`${countOf(unreadableFileCount, "file", "files")} could not be opened.`]),
  ];
}

/** A figure and its noun, agreeing. */
function countOf(count: number, singular: string, plural: string): string {
  return `${formatCount(count)} ${count === 1 ? singular : plural}`;
}
