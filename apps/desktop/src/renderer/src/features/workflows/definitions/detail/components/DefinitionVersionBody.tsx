// One version's body as the detail draws it: the marker and hash that identify these bytes, and
// the phases they sequence. Every figure is the wire's, rendered verbatim through `WireFigure`;
// the content hash is BLAKE3 over the RFC 8785 canonical form, which the console neither
// computes nor parses. The phase order is the daemon's and is never re-sorted.

import { Chip } from "@renderer/components/Chip/Chip.js";
import { WireFigure } from "@renderer/components/WireFigure/WireFigure.js";
import { formatCount } from "@renderer/lib/wire-figures.js";
import type { WorkflowVersionBody } from "@renderer/services/wire-shapes/workflow-definition-body.js";
import { DefinitionPhaseRow } from "./DefinitionPhaseRow.js";

/** The served version body to draw. */
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
         * The entry record's member as the wire's word: prose composed here would stop matching
         * when the vocabulary grows.
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
