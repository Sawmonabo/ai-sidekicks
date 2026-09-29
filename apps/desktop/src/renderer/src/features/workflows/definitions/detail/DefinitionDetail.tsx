// What a definition's detail shows once its reads have answered.
//
// THREE STATES AND NO OTHERS, which is `run-snapshot.ts`'s rule for the same seam: no
// definition is named so nothing was asked, a read is in flight, or the definition
// came back. Everything arrives as props: `definition-detail-read.ts` composes the
// reads and `definition-authoring-dispatch.ts` the acts, and whichever container wires
// their calls hands the products here.
//
// A chain that could not be addressed says so without taking the body down with it.
//
// WHAT THIS IS NOT. It is not the canvas. The node graph, the inspector and the
// connection-validity predicate are the workflow engine's body, mounted through the
// builder pane's own typed slots; this is the read the canvas will be drawn from and
// the acts that carry a definition somewhere else.

import { Nothing, WireFigure, formatCount } from "@renderer/console/primitives/index.js";
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
    // A container that names no definition has asked nothing, so nothing is drawn.
    return <></>;
  }
  if (detail.status === "reading") {
    return <Nothing kind="not-loaded" placement="surface" title="Reading this definition." />;
  }
  const { definition, version, chain } = detail.detail;
  return (
    <div className="meridian-definition-detail">
      <dl className="meridian-definition-detail__facts">
        <dt>Definition</dt>
        <dd>{definition.name}</dd>
        <dt>Scope</dt>
        {/*
         * The scope and the identity it refers to, side by side and never joined into
         * one string: `shared` is daemon-wide and carries the empty string, so a
         * composed label would read as a scope with a blank name rather than as one
         * that refers to nothing narrower.
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
