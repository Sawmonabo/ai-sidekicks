// What a definition's detail shows once its reads have answered: no definition named (nothing
// asked), a read in flight, or the definition. Everything arrives as props from the container.
// A chain that could not be addressed says so without taking the body down. This is not the
// canvas, which is the workflow engine's body mounted through the builder pane.

import { Nothing } from "@renderer/components/Nothing/Nothing.js";
import { WireFigure } from "@renderer/components/WireFigure/WireFigure.js";
import { formatCount } from "@renderer/lib/wire-figures.js";
import { DefinitionAuthoringActs } from "./components/DefinitionAuthoringActs.js";
import { DefinitionVersions } from "./components/DefinitionVersions.js";
import { DefinitionVersionBody } from "./components/DefinitionVersionBody.js";
import type { WorkflowDefinitionAuthoring } from "./definition-authoring.js";
import type { WorkflowDefinitionDetailState } from "./hooks/useWorkflowDefinitionDetail.js";

/** What one definition's detail draws: where its reads stand and the acts it offers. */
export interface DefinitionDetailProps {
  /** Where the definition's reads stand. */
  readonly detail: WorkflowDefinitionDetailState;
  /** The two acts the detail offers, and where each got to. */
  readonly authoring: WorkflowDefinitionAuthoring;
}

/** One definition, drawn from the read state and the acts its container hands in. */
export function DefinitionDetail(props: DefinitionDetailProps): React.JSX.Element {
  const { detail, authoring } = props;
  if (detail.status === "unasked") {
    // No definition is named, so nothing was asked and nothing is drawn.
    return <></>;
  }
  if (detail.status === "reading") {
    return <Nothing kind="not-loaded" placement="block" title="Reading this definition." />;
  }
  const { definition, version, chain } = detail.detail;
  return (
    <div className="meridian-definition-detail">
      <dl className="meridian-definition-detail__facts">
        <dt>Definition</dt>
        <dd>{definition.name}</dd>
        <dt>Scope</dt>
        {/*
         * Scope and identity side by side, never joined: `shared` carries the empty string, so a
         * joined label would read as a scope with a blank name.
         */}
        <dd>
          <WireFigure value={definition.scope} />
          {definition.scopeRef === undefined || definition.scopeRef === "" ? null : (
            <WireFigure value={definition.scopeRef} />
          )}
        </dd>
        <dt>Latest version</dt>
        <dd>
          <WireFigure
            value={formatCount(definition.versionNumber)}
            title={`${definition.versionNumber}`}
          />
        </dd>
      </dl>
      <DefinitionVersionBody body={version} />
      <DefinitionVersions chain={chain} />
      <DefinitionAuthoringActs authoring={authoring} />
    </div>
  );
}
