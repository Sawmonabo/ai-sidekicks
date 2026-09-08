// What the builder pane shows once its definition has been read.
//
// THE PANE'S SUBJECT, FINALLY ASKED ABOUT. The builder pane has addressed a definition
// since it was built and could put no question about one: the definition read, the
// version read and the create were registered method strings on no growth-port row, so
// the addressed arm rendered "this definition has not been read in this window" under
// every bridge including the fixture. That sentence was true and is now only true when
// it is — the reads are put, and what comes back is what stands here.
//
// FOUR STATES AND NO OTHERS, which is `run-snapshot.ts`'s rule for the same seam: the
// pane names no definition so nothing was asked, a read is in flight, the definition
// came back, or the read refused. A refused read is NOT an empty definition — drawing
// one would assert that the definition has no phases, which is a claim about the daemon
// that nothing established.
//
// AND THE THREE READS SETTLE SEPARATELY. `definition-detail-read.ts` composes them and
// says why; what this component does with the result is render each answer where it
// stands, so a refused version body leaves the identity on screen with the body's own
// refusal beside it, and a chain that could not be addressed says so without taking the
// body down with it. Folding all three into one absence would withdraw facts the daemon
// answered.
//
// WHAT THIS IS NOT. It is not the canvas. The node graph, the inspector and the
// connection-validity predicate are Plan-017's body, mounted through the builder pane's
// own typed slots; this is the read the canvas will be drawn from and the acts that
// carry a definition somewhere else.

import { Nothing, RefusalBanner, WireFigure, formatCount } from "../../../primitives/index.js";
import type { ConsoleBridge } from "../../../bridge/index.js";
import { DefinitionAuthoringActs } from "./DefinitionAuthoringActs.js";
import { DefinitionChain } from "./DefinitionChain.js";
import { DefinitionVersionBody } from "./DefinitionVersionBody.js";
import { useWorkflowDefinitionAuthoring } from "./definition-authoring-dispatch.js";
import { useWorkflowDefinitionDetail } from "./definition-detail-read.js";

export interface DefinitionDetailProps {
  readonly bridge: ConsoleBridge;
  /** The definition this pane is addressed at, already narrowed by the pane's guard. */
  readonly workflowDefinitionId: string;
  /** The session the pane is bound to, or `undefined` on a bare route. */
  readonly sessionId: string | undefined;
}

/** One definition, read and drawn. */
export function DefinitionDetail(props: DefinitionDetailProps): React.JSX.Element {
  const { bridge, workflowDefinitionId, sessionId } = props;
  const detail = useWorkflowDefinitionDetail(bridge.growth, workflowDefinitionId);
  const body =
    detail.status === "served" && detail.detail.version.status === "served"
      ? detail.detail.version.body
      : undefined;
  // Composed on every arm rather than inside the served one: a hook may not be called
  // conditionally, and the acts are held against the definition this pane is addressed
  // at whether or not its read has answered yet.
  const authoring = useWorkflowDefinitionAuthoring(bridge, workflowDefinitionId, sessionId, body);

  if (detail.status === "unasked") {
    // Unreachable through the builder pane, whose guard narrows the address before it
    // composes this — and rendered rather than thrown, because an arm that cannot be
    // reached through one caller is not an arm that may take the deck down.
    return (
      <Nothing
        kind="not-checked"
        placement="surface"
        title="This pane named no definition, so nothing was asked."
      />
    );
  }
  if (detail.status === "reading") {
    return (
      <Nothing
        kind="not-loaded"
        placement="surface"
        title="Reading this definition."
        detail="The definition, the version it is at, and that version's chain are three reads; each settles on its own."
      />
    );
  }
  if (detail.status === "unavailable") {
    return <RefusalBanner {...detail.refusal} />;
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
      {version.status === "served" ? (
        <DefinitionVersionBody body={version.body} />
      ) : (
        <RefusalBanner {...version.refusal} />
      )}
      <DefinitionChain chain={chain} />
      <DefinitionAuthoringActs authoring={authoring} />
    </div>
  );
}
