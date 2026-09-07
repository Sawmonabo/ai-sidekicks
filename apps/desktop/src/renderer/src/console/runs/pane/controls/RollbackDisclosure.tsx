// What a settled rollback did, said once, with nothing hidden.
//
// THIS COMPONENT'S OWN DENSITY RULE, because no committed document states it: the
// preview shows scope and target position, and the two file enumerations are
// collapsed behind a count chip that reads zero honestly and expands in place. So
// the settlement is a
// sentence and a disposition chip, the daemon's positions sit beside it as wire
// figures, and each enumeration is a `<details>` whose summary carries its own
// count — including when that count is zero, which is a fact the participant needs
// rather than a row to omit.
//
// THE COUNT CHIP READS ZERO HONESTLY. An empty enumeration means nothing was
// overwritten and nothing diverged; an ABSENT one is a parse failure the registered
// schema already refuses. Rendering "0 overwritten" is therefore a statement, and
// hiding the row when the list is empty would put the reader back in the position
// of not knowing which of the two they were looking at — the exact conflation
// `Spec-010 §Turn-Boundary Snapshots` mandates against.

import { Chip, WireFigure } from "../../../primitives/index.js";
import { resendSettlementSentence, type RollbackDispositionReading } from "./rollback-result.js";
import { FileEnumeration } from "./FileEnumeration.js";

export interface RollbackDisclosureProps {
  readonly reading: RollbackDispositionReading;
}

export function RollbackDisclosure(props: RollbackDisclosureProps): React.JSX.Element {
  const { reading } = props;
  const resendSentence = resendSettlementSentence(reading.resendDisposition);
  return (
    <div className="meridian-rollback">
      <div className="meridian-rollback__head">
        <Chip tone={reading.tone} label={reading.disposition} mono />
        <Chip
          tone={reading.settlementClass === "applied" ? "neutral" : "attention"}
          label={reading.settlementClass}
          mono
        />
      </div>
      <p className="meridian-rollback__summary">{reading.summary}</p>
      {resendSentence === undefined ? null : (
        <p className="meridian-rollback__resend">{resendSentence}</p>
      )}
      {reading.isNonResumable ? (
        <p className="meridian-rollback__standing">
          A later resume of this run refuses with{" "}
          <WireFigure value="run.compaction_boundary_diverged" />.
        </p>
      ) : null}
      {reading.positions.length === 0 ? null : (
        <dl className="meridian-rollback__positions">
          {reading.positions.map((position) => (
            <div className="meridian-rollback__position" key={position.label}>
              <dt>{position.label}</dt>
              <dd>
                {position.position === null ? (
                  // The wire's own `null`, which `boundary-diverged` carries when a
                  // position-less compaction row classifies as crossing for every
                  // target of the run. Rendered as an absence with its reason, never
                  // as a zero the console chose.
                  <span className="meridian-rollback__no-position">
                    none — the boundary row carries no position
                  </span>
                ) : (
                  <WireFigure value={String(position.position)} />
                )}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {reading.files === undefined ? null : (
        <div className="meridian-rollback__files">
          <FileEnumeration
            label="Overwritten ignored paths"
            paths={reading.files.overwrittenIgnoredPaths}
          />
          <FileEnumeration label="Divergent gitlinks" paths={reading.files.divergentGitlinks} />
        </div>
      )}
    </div>
  );
}
