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
// THE FILE HALF IS DELEGATED AND NOT RE-DRAWN. This component owns what the rewind
// did to the RUN and the conversation — the settlement class, the sentence, the
// replacement leg, the standing non-resumability, and the daemon's positions. What
// it did to the working TREE is `FileRestoreDisclosure`'s, which renders both
// never-silent enumerations with a control on every path, says what an empty pair
// does and does not mean, and names the failed step. Two components rather than one
// because the two questions have different readers, and one component rather than a
// second copy of the enumerations because a second copy is how the two came to
// disagree about whether an empty list is an all-clear.
//
// IT MOUNTS ON EXACTLY THE ARMS THAT CARRY ENUMERATIONS, which is the reading's own
// answer (`files !== undefined`) and never a check on the disposition name: they ride
// `files-restored`, `files-partially-restored`, and `resend-unapplied`, and a
// disposition that mutated no file has no working tree to disclose.

import {
  Chip,
  FileRestoreDisclosure,
  InlineRefusal,
  WireFigure,
} from "../../../primitives/index.js";
import { resendSettlementSentence, type RollbackDispositionReading } from "./rollback-result.js";
import { ENUMERATED_PATH_ACTION_LABEL } from "./enumerated-path-action.js";
import type { RollbackInterventionResult } from "@ai-sidekicks/contracts";
import type { ConsoleRefusal } from "../../../core/index.js";

export interface RollbackDisclosureProps {
  readonly reading: RollbackDispositionReading;
  /** The wire result itself, for the working-tree half this component delegates. */
  readonly result: RollbackInterventionResult;
  /** What the mounting surface offers on one enumerated path. */
  readonly onPathAction: ((path: string) => void) | undefined;
  /** The host's refusal of that action, rendered beside the enumeration it failed. */
  readonly pathActionRefusal: ConsoleRefusal | undefined;
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
          <FileRestoreDisclosure
            result={props.result}
            onOpenPath={props.onPathAction}
            pathActionLabel={ENUMERATED_PATH_ACTION_LABEL}
          />
          {props.pathActionRefusal === undefined ? null : (
            <InlineRefusal
              code={props.pathActionRefusal.code}
              detail={props.pathActionRefusal.detail}
            />
          )}
        </div>
      )}
    </div>
  );
}
