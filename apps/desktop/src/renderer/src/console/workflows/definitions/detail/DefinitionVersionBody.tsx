// One version's body, as the detail draws it: the marker and hash that identify these
// bytes, the phases they sequence, and the chain the version belongs to.
//
// A SIBLING RATHER THAN A SECOND COMPONENT IN `DefinitionDetail.tsx`, which is the
// package's one-component-per-`.tsx` rule — `DefinitionListItem.tsx` is the precedent
// one directory up, and for the same reason: a module holding two components is a
// module whose name answers for one of them.
//
// EVERY FIGURE IS THE WIRE'S. The content hash is BLAKE3 over the RFC 8785
// canonicalization and the console neither computes nor parses one; the schema marker
// is a string no corpus document registers a value for. Both are rendered verbatim in
// mono through `WireFigure`, which is the one module in the console that formats a wire
// value at all.
//
// AND THE PHASE ORDER IS THE DAEMON'S. The sequence arrives in the order the definition
// runs it, and this component re-sorts nothing: a renderer that ordered phases by their
// dependency lists would be a second authority on a topology the definition already
// states, and the two would agree until a definition described a shape the sort did not
// expect.

import { Chip, WireFigure, formatCount } from "../../../primitives/index.js";
import type { WorkflowVersionBody } from "../../../bridge/index.js";
import { DefinitionPhaseRow } from "./DefinitionPhaseRow.js";

export interface DefinitionVersionBodyProps {
  readonly body: WorkflowVersionBody;
}

/** The version body's own block: its identity, its entry, and its phases. */
export function DefinitionVersionBody(props: DefinitionVersionBodyProps): React.JSX.Element {
  const { body } = props;
  return (
    <section className="meridian-definition-detail__version">
      <h4 className="meridian-definition-detail__heading">
        Version{" "}
        <WireFigure value={formatCount(body.versionNumber)} title={`${body.versionNumber}`} />
      </h4>
      <dl className="meridian-definition-detail__facts">
        <dt>Content hash</dt>
        <dd>
          <WireFigure value={body.contentHash} />
        </dd>
        <dt>Schema</dt>
        <dd>
          <WireFigure value={body.schemaVersion} />
        </dd>
        <dt>Starts</dt>
        {/*
         * The entry record's one member, rendered as the word the wire carries. A
         * sentence composed here — "started by hand" — would be this console
         * translating a closed vocabulary into prose that stops matching the day the
         * vocabulary grows a second member.
         */}
        <dd>
          <Chip mono label={body.entry.startMode} />
        </dd>
      </dl>
      <ol className="meridian-definition-detail__phases">
        {body.phaseDefinitions.map((phase) => (
          <DefinitionPhaseRow key={phase.phaseId} phase={phase} />
        ))}
      </ol>
    </section>
  );
}
