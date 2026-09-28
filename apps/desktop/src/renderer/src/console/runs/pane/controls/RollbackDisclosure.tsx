// What a settled rollback did, said once, with nothing hidden.
//
// The settlement is a sentence and a disposition chip, and the working tree's two
// file enumerations are collapsed behind a count chip that reads zero honestly and
// expands in place, because a count of zero is a fact the user needs rather than a row
// to omit.
//
// THE FILE HALF IS DELEGATED AND NOT RE-DRAWN. This component owns what the rewind
// did to the RUN and the conversation — the settlement class, the sentence, and the
// replacement leg. What it did to the working TREE is `FileRestoreDisclosure`'s, which
// renders both never-silent enumerations, says what an empty pair does and does not
// mean, and names the failed step. Two components rather than one because the two
// questions have different readers, and one component rather than a second copy of the
// enumerations because a second copy is how the two came to disagree about whether an
// empty list is an all-clear.
//
// AND THAT HALF ARRIVES ON ITS OWN CHUNK. It is drawn only under a settlement that
// touched files, so the package's module-shape rule reaches it through a loader —
// `file-restore-mount.ts` beside this file. What renders while the chunk is in flight
// is the substrate's hidden reserved region: no spinner, no skeleton, nothing that
// moves this settlement's layout.
//
// IT MOUNTS ON EXACTLY THE ARMS THAT CARRY ENUMERATIONS, which is the reading's own
// answer (`files !== undefined`) and never a check on the disposition name: they ride
// `files-restored`, `files-partially-restored`, and `resend-unapplied`, and a
// disposition that mutated no file has no working tree to disclose.

import { Chip } from "../../../primitives/index.js";
import { fileRestoreDisclosureMount } from "./file-restore-mount.js";
import {
  resendSettlementSentence,
  type RollbackDispositionReading,
} from "./rollback/disposition-reading.js";
import type { RollbackInterventionResult } from "@ai-sidekicks/contracts";

export interface RollbackDisclosureProps {
  readonly reading: RollbackDispositionReading;
  /** The wire result itself, for the working-tree half this component delegates. */
  readonly result: RollbackInterventionResult;
}

/**
 * The settled rollback, as a sentence, a disposition, and the working tree's counts.
 *
 * @consumedBy the composer's undo readout
 */
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
      {reading.files === undefined ? null : (
        <div className="meridian-rollback__files">
          {/* The mount's own render and not an element built here: what a loader-backed
              body renders is the mount's decision — the settled body where its chunk has
              landed, the substrate's hidden reserved region where it has not — and this
              component's job is to say which props it takes. */}
          {fileRestoreDisclosureMount.render({ result: props.result })}
        </div>
      )}
    </div>
  );
}
