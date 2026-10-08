import { useId } from "react";

import type {
  WorkflowRunAttentionEntry,
  WorkflowRunAttentionListResponse,
} from "@ai-sidekicks/contracts/workflow/run/records";

import { LoadingNotice } from "#renderer/components/LoadingNotice/LoadingNotice.js";
import { Nothing } from "#renderer/components/Nothing/Nothing.js";
import type { Clock } from "#renderer/lib/clock.js";
import type { PushDrivenReadState } from "#renderer/store/reads/push-driven.js";
import { TryAgainButton } from "#renderer/components/TryAgainButton/TryAgainButton.js";
import { DayClockFigure } from "#renderer/components/DayClockFigure/DayClockFigure.js";
import { FigureSentence } from "#renderer/components/FigureSentence/FigureSentence.js";
import type { FigureSentencePart } from "#renderer/lib/figure-sentence.js";
import { runCountWords, spentAccountWords } from "../../words.js";
import { partOfDayAt } from "../part-of-day.js";

/**
 * The runs waiting on a person, in their own section above the runs table, exactly as the daemon
 * grouped them: the entries for a spent account first, each one line with how many runs it holds,
 * then one line per run, oldest first, naming the step that waits. The filters never narrow it.
 * With nothing waiting it reads `Nothing waiting`, and says how many runs this sitting answered
 * where there were any; while the read is in flight or has failed it says that instead, never
 * `Nothing waiting`.
 */
export function RunAttentionSection(props: {
  readonly state: PushDrivenReadState<WorkflowRunAttentionListResponse>;
  readonly readAgain: () => void;
  readonly onOpenRun: (workflowRunId: string) => void;
  /** The instant the clock figures read against, which also names the part of the day. */
  readonly nowMs: number;
  /** The machine's clock locale, which the clock figures are written in. */
  readonly clockLocale: string;
  /** The window's clock, which holds the loading line back for the short delay. */
  readonly clock: Clock;
  /** How many runs a person answered since this screen opened. */
  readonly answeredCount: number;
}): React.JSX.Element {
  const headingId = useId();
  const { state } = props;
  return (
    <section className="meridian-workflows-attention" aria-labelledby={headingId}>
      <h2 id={headingId} className="meridian-visually-hidden">
        Waiting on you
      </h2>
      {state.kind === "not-loaded" ? (
        <LoadingNotice clock={props.clock} placement="block" title="Loading what is waiting…" />
      ) : state.kind === "failed" ? (
        <Nothing
          kind="error"
          placement="block"
          title="Could not load what is waiting"
          detail={state.refusal.detail}
          action={<TryAgainButton onPress={props.readAgain} />}
          attempt={state.refusal}
        />
      ) : state.value.entries.length === 0 ? (
        <p className="meridian-workflows-attention__nothing">
          <FigureSentence parts={nothingWaiting(props.answeredCount, props.nowMs)} />
        </p>
      ) : (
        <ul className="meridian-workflows-attention__entries">
          {state.value.entries.map((entry) => (
            <li key={entryKey(entry)} className="meridian-workflows-attention__entry">
              <AttentionLine
                entry={entry}
                onOpenRun={props.onOpenRun}
                nowMs={props.nowMs}
                clockLocale={props.clockLocale}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function AttentionLine(props: {
  readonly entry: WorkflowRunAttentionEntry;
  readonly onOpenRun: (workflowRunId: string) => void;
  readonly nowMs: number;
  readonly clockLocale: string;
}): React.JSX.Element {
  const { entry, clockLocale } = props;
  if (entry.kind === "account") {
    const verb = entry.affectedRunCount === 1 ? "waits" : "wait";
    const account = spentAccountWords(entry.account);
    // The reset is named only where the daemon armed the instant the runs resume.
    return (
      <span>
        <FigureSentence
          parts={[
            ...runCountWords(entry.affectedRunCount, "wire"),
            ` ${verb} on the ${account}, which is spent`,
          ]}
        />
        {entry.resumeAt === undefined ? null : (
          <>
            {" until "}
            <DayClockFigure at={entry.resumeAt} nowMs={props.nowMs} locale={clockLocale} />
          </>
        )}
        .
      </span>
    );
  }
  return (
    <span>
      <button
        type="button"
        className="meridian-workflow-run__link"
        onClick={() => {
          props.onOpenRun(entry.workflowRunId);
        }}
      >
        {entry.workflowName}
      </button>
      <span className="meridian-workflows-attention__cause">
        {` · waiting on ${entry.waitingStepName} · since `}
        <DayClockFigure at={entry.waitingSince} nowMs={props.nowMs} locale={clockLocale} />
      </span>
    </span>
  );
}

/**
 * `Nothing waiting`, and `· you answered 4 runs this morning` where this sitting answered any, a
 * count the app keeps itself.
 */
function nothingWaiting(answeredCount: number, nowMs: number): readonly FigureSentencePart[] {
  if (answeredCount === 0) {
    return ["Nothing waiting"];
  }
  return [
    "Nothing waiting · you answered ",
    ...runCountWords(answeredCount, "derived"),
    ` this ${partOfDayAt(nowMs)}`,
  ];
}

function entryKey(entry: WorkflowRunAttentionEntry): string {
  return entry.kind === "account"
    ? `account:${entry.account.providerAccountId}`
    : `run:${entry.workflowRunId}`;
}
