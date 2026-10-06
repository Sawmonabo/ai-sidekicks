import "./StepPayload.css";

import { CopyButton } from "#renderer/components/CopyButton/CopyButton.js";
import { usePayloadJsonCopy } from "./StepPayload/hooks/usePayloadJsonCopy.js";
import type { StepPayloadView } from "./StepPayload.js";

/**
 * One of a step's own record tabs, its cost or its error: drawn in the table view, the member
 * exactly as stored in the JSON view (`null` where the step carries none), and `Copy as JSON`.
 */
export function StepRecordTab(props: {
  /** The record member as the run read carries it; `undefined` where the step has none. */
  readonly stored: unknown;
  readonly view: StepPayloadView;
  /** Names the record for what is said out loud about it: `Cost of Summarize`. */
  readonly label: string;
  /** The table view's drawing of the member. */
  readonly children: React.ReactNode;
}): React.JSX.Element {
  const json = props.stored ?? null;
  const clipboardCopy = usePayloadJsonCopy(json, props.label);
  return (
    <div className="meridian-workflow-payload">
      <div className="meridian-workflow-payload__bar">
        <CopyButton label="Copy as JSON" clipboardCopy={clipboardCopy} />
      </div>
      {props.view === "json" ? (
        <pre className="meridian-workflow-payload__json" aria-label={props.label}>
          {JSON.stringify(json, null, 2)}
        </pre>
      ) : (
        props.children
      )}
    </div>
  );
}
