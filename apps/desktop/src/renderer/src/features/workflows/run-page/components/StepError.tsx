import type { WorkflowStep } from "@ai-sidekicks/contracts/workflow/run/run";

import { formatCount } from "@renderer/lib/wire-figures.js";
import { codeWords } from "../../workflow-words.js";

/**
 * The Error tab's table view: the failure's code in words, the item it failed on, its message,
 * and, where the step's process ended on its own, its exit code or signal over the last lines it
 * printed.
 */
export function StepError(props: { readonly step: WorkflowStep }): React.JSX.Element {
  const { error, processExit } = props.step;
  if (error === undefined) {
    return <p className="meridian-workflow-step__note">This step did not fail.</p>;
  }
  return (
    <div className="meridian-workflow-step__error">
      {error.code === undefined ? null : (
        <p className="meridian-workflow-step__error-label">{codeWords(error.code)}</p>
      )}
      {error.itemIndex === undefined ? null : (
        <p className="meridian-workflow-step__error-item">{`Item ${formatCount(error.itemIndex)}`}</p>
      )}
      <p className="meridian-workflow-step__error-message">{error.message}</p>
      {processExit === undefined ? null : (
        <>
          <p className="meridian-workflow-step__error-item">{exitWords(processExit)}</p>
          <pre className="meridian-workflow-step__log-tail" aria-label="Last log lines">
            {processExit.outputTail}
          </pre>
        </>
      )}
    </div>
  );
}

function exitWords(processExit: NonNullable<WorkflowStep["processExit"]>): string {
  if (processExit.exitCode !== undefined) {
    return `Exit code ${formatCount(processExit.exitCode)}`;
  }
  return processExit.signal === undefined ? "Exited" : `Ended by ${processExit.signal}`;
}
