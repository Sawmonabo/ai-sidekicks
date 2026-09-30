// What one provider's import stream has said, in its own words.
//
// Its own module rather than a second component beside the panel, which the console's
// one-component-per-module rule forbids — and the split earns itself here: the panel
// owns the start call and its disclosure, and this owns the arms one stream can be in.
//
// EVERY ARM RENDERS, including the ones that are easy to leave out: an open stream that
// has not spoken yet is "nothing counted so far" and never a blank, a closed one that
// never spoke is a stream that ended having said nothing, and every way an import
// ends — finished, nothing new, stopped, refused — has its own sentence.
//
// NOTHING IS COMPUTED FROM THE MESSAGES. The counts and the refusal are the service's
// own; a percentage would be this console inventing a denominator nobody sent.

import type { ProviderImportOutcome } from "@ai-sidekicks/contracts";
import { WireFigure } from "@renderer/components/WireFigure/WireFigure.js";
import { formatCount } from "@renderer/lib/wire-figures.js";
import type { ImportProgressReading } from "./import-progress.js";

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
  const { newest } = progress;
  if (newest === undefined) {
    return (
      <p className="meridian-session-import__progress" aria-live="polite">
        {progress.status === "open"
          ? "Reading. Nothing counted yet."
          : "The import ended without reporting anything."}
      </p>
    );
  }
  if (newest.kind === "progress") {
    return (
      <p className="meridian-session-import__progress" aria-live="polite">
        Reading — {countOf(newest.read, "conversation", "conversations")} read so far.
      </p>
    );
  }
  const { settlement } = newest;
  return (
    <p className="meridian-session-import__progress" aria-live="polite">
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
        `The last import brought in ${formatCount(settlement.imported)} of ${countOf(settlement.total, "conversation", "conversations")}; ${formatCount(settlement.alreadyHere)} already here.`,
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
