import "./StepPayload.css";

import type { WorkflowItem } from "@ai-sidekicks/contracts/workflow/definition/definition";

import { CopyButton } from "#renderer/components/CopyButton/CopyButton.js";
import { formatByteQuantity } from "#renderer/lib/wire/figures.js";
import type { StepPayloadStorage } from "../hooks/useStepPayloadRead.js";
import { PayloadJson } from "./StepPayload/PayloadJson.js";
import { PayloadTable } from "./StepPayload/PayloadTable.js";
import { usePayloadJsonCopy } from "./StepPayload/hooks/usePayloadJsonCopy.js";
import { itemCountWords } from "#renderer/features/workflows/words.js";

/** How a payload is read: drawn by its type, or exactly as it was stored. */
export type StepPayloadView = "table" | "json";

/** What one of a step's payloads is drawn from. */
export interface StepPayloadProps {
  readonly items: readonly WorkflowItem[];
  /** Where the items were kept, which the panel says. */
  readonly storage: StepPayloadStorage;
  readonly view: StepPayloadView;
  /** Names the payload for what is said out loud about it: `Output of Summarize`. */
  readonly label: string;
}

/**
 * One of a step's payloads — its input, output or log — with `Copy as JSON`, saying whether it
 * was read inline or from an artifact, and how many items it holds.
 */
export function StepPayload(props: StepPayloadProps): React.JSX.Element {
  const clipboardCopy = usePayloadJsonCopy(props.items, props.label);
  const count = itemCountWords(props.items.length);
  const note =
    props.storage.kind === "inline"
      ? `Inline · ${count}`
      : `Read from an artifact · ${formatByteQuantity(props.storage.sizeBytes).text} · ${count}`;
  return (
    <div className="meridian-workflow-payload">
      <div className="meridian-workflow-payload__bar">
        <p className="meridian-workflow-payload__note">{note}</p>
        <CopyButton label="Copy as JSON" clipboardCopy={clipboardCopy} />
      </div>
      {props.view === "json" ? (
        <PayloadJson items={props.items} label={props.label} />
      ) : (
        <PayloadTable items={props.items} label={props.label} />
      )}
    </div>
  );
}
