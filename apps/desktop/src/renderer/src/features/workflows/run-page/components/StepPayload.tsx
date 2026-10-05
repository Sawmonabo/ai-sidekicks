import "./StepPayload.css";

import type { ArtifactId } from "@ai-sidekicks/contracts/provider-driver";
import type { WorkflowItem } from "@ai-sidekicks/contracts/workflow-definition";
import type { WorkflowPayloadRef } from "@ai-sidekicks/contracts/workflow-run";

import { CopyButton } from "@renderer/components/CopyButton/CopyButton.js";
import { InlineRefusal } from "@renderer/components/Refusal/InlineRefusal.js";
import { formatByteQuantity } from "@renderer/lib/wire-figures.js";
import { PayloadJson } from "./StepPayload/PayloadJson.js";
import { PayloadTable } from "./StepPayload/PayloadTable.js";
import { usePayloadJsonCopy } from "./StepPayload/hooks/usePayloadJsonCopy.js";
import { useStepPayloadArtifact } from "./StepPayload/hooks/useStepPayloadArtifact.js";
import { itemCountWords } from "../../workflow-words.js";
import { ActionButton } from "../../components/ActionButton.js";

/** How a payload is read: drawn by its type, or exactly as it was stored. */
export type StepPayloadView = "table" | "json";

/** What one of a step's payloads is drawn from. */
export interface StepPayloadProps {
  readonly payload: WorkflowPayloadRef;
  readonly view: StepPayloadView;
  /** Names the payload for what is said out loud about it: `Output of Summarize`. */
  readonly label: string;
}

/**
 * One of a step's payloads — its input, output or log — with `Copy as JSON`. The panel says
 * which kind it is reading: one carried inline is drawn at once; a larger one was kept as an
 * artifact, and `Open as artifact` reads it and draws it the same way.
 */
export function StepPayload(props: StepPayloadProps): React.JSX.Element {
  const { payload } = props;
  switch (payload.kind) {
    case "inline":
      return (
        <PayloadBody
          note={`Inline · ${itemCountWords(payload.items.length)}`}
          items={payload.items}
          view={props.view}
          label={props.label}
        />
      );
    case "artifact":
      return (
        <ArtifactPayload
          // A new artifact starts unopened, so switching tabs never shows another's items.
          key={payload.artifactId}
          artifactId={payload.artifactId}
          sizeBytes={payload.sizeBytes}
          itemCount={payload.itemCount}
          view={props.view}
          label={props.label}
        />
      );
  }
}

/** A payload kept as an artifact: its size and `Open as artifact`, then its items once read. */
function ArtifactPayload(props: {
  readonly artifactId: ArtifactId;
  readonly sizeBytes: number;
  readonly itemCount: number;
  readonly view: StepPayloadView;
  readonly label: string;
}): React.JSX.Element {
  const artifact = useStepPayloadArtifact(props.artifactId);
  const size = formatByteQuantity(props.sizeBytes).text;
  const { state } = artifact;
  if (state.kind === "read") {
    return (
      <PayloadBody
        note={`Read from an artifact · ${size} · ${itemCountWords(state.items.length)}`}
        items={state.items}
        view={props.view}
        label={props.label}
      />
    );
  }
  return (
    <div className="meridian-workflow-payload">
      <div className="meridian-workflow-payload__bar">
        <p className="meridian-workflow-payload__note">
          {`Stored as an artifact · ${size} · ${itemCountWords(props.itemCount)}`}
        </p>
        <ActionButton disabled={state.kind === "reading"} onClick={artifact.open}>
          Open as artifact
        </ActionButton>
      </div>
      {state.kind === "refused" ? (
        <InlineRefusal code={state.refusal.code} detail={state.refusal.detail} />
      ) : null}
    </div>
  );
}

/** A payload's items, with what kind of payload it is, its count and `Copy as JSON`. */
function PayloadBody(props: {
  readonly note: string;
  readonly items: readonly WorkflowItem[];
  readonly view: StepPayloadView;
  readonly label: string;
}): React.JSX.Element {
  const clipboardCopy = usePayloadJsonCopy(props.items, props.label);
  return (
    <div className="meridian-workflow-payload">
      <div className="meridian-workflow-payload__bar">
        <p className="meridian-workflow-payload__note">{props.note}</p>
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
