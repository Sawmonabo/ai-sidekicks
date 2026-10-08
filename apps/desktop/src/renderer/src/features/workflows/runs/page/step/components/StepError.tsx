import type { WorkflowStep } from "@ai-sidekicks/contracts/workflow/run/step/record";

import { formatCount, formatNumericCode } from "#renderer/lib/wire/figures.js";
import { WireFigure } from "#renderer/components/WireFigure/WireFigure.js";
import { codeWords } from "#renderer/lib/code-words.js";

/**
 * The Error tab's table view: the failure's code in words with its reason, the item it failed on,
 * its message, and, where the step's process ended on its own, its exit code or signal over the
 * last lines it printed.
 */
export function StepError(props: { readonly step: WorkflowStep }): React.JSX.Element {
  const { error, processExit } = props.step;
  if (error === undefined) {
    return <p className="meridian-workflow-step__note">This step did not fail.</p>;
  }
  return (
    <div className="meridian-workflow-step__error">
      {error.code === undefined ? null : (
        <p className="meridian-workflow-step__error-label">
          {failureLabel(error.code, error.details)}
        </p>
      )}
      {error.itemIndex === undefined ? null : (
        <p className="meridian-workflow-step__error-item">
          Item <WireFigure value={formatCount(error.itemIndex)} />
        </p>
      )}
      <p className="meridian-workflow-step__error-message">{error.message}</p>
      {processExit === undefined ? null : (
        <>
          <p className="meridian-workflow-step__error-item">
            <ProcessExitWords processExit={processExit} />
          </p>
          <pre className="meridian-workflow-step__log-tail" aria-label="Last log lines">
            {processExit.outputTail}
          </pre>
        </>
      )}
    </div>
  );
}

/**
 * The failure's code in words, with its closed reason or cause after it where the code carries
 * one: `workflow.step_thread_failed` with reason `out_of_memory` reads
 * `Step thread failed · Out of memory`.
 */
function failureLabel(
  code: string,
  details: Readonly<Record<string, unknown>> | undefined,
): string {
  const why = details?.["reason"] ?? details?.["cause"];
  return codeWords(code, typeof why === "string" ? why : undefined);
}

// The wire carries exactly one of the exit code and the signal. An exit code is a code, read as
// it was sent, not a count.
function ProcessExitWords(props: {
  readonly processExit: NonNullable<WorkflowStep["processExit"]>;
}): React.JSX.Element {
  const { processExit } = props;
  return processExit.signal === undefined ? (
    <>
      Exit code <WireFigure value={formatNumericCode(processExit.exitCode)} />
    </>
  ) : (
    <>Ended by {processExit.signal}</>
  );
}
