// What a settled rollback did, said once, with nothing hidden.
//
// The settlement is a sentence and a disposition chip, and what the rewind did to the
// working tree sits under them.
//
// THE FILE HALF IS DELEGATED AND NOT RE-DRAWN. This component owns what the rewind
// did to the RUN and the conversation — the settlement class, the sentence, and the
// replacement leg. What it did to the working TREE is `FileRestoreDisclosure`'s, which
// says what each disposition means for the files. Two components rather than one
// because the two questions have different readers.
//
// AND THAT HALF ARRIVES ON ITS OWN CHUNK, so the package's module-shape rule reaches it
// through a loader — `file-restore-mount.ts` beside this file. What renders while the
// chunk is in flight is the substrate's hidden reserved region: no spinner, no
// skeleton, nothing that moves this settlement's layout. Every disposition draws it,
// because each one says something about the files, including that none was touched.

import { Chip } from "../../../primitives/index.js";
import { fileRestoreDisclosureMount } from "./file-restore-mount.js";
import {
  resendSettlementSentence,
  type RollbackDispositionReading,
} from "./rollback/disposition-reading.js";
import type { RollbackAppliedResult, RollbackDegradedResult } from "@ai-sidekicks/contracts";

/** What a settled rollback is disclosed from: its reading and the wire result. */
export interface RollbackDisclosureProps {
  readonly reading: RollbackDispositionReading;
  /** The wire result itself, for the working-tree half this component delegates. */
  readonly result: RollbackAppliedResult | RollbackDegradedResult;
}

/**
 * The settled rollback, as a sentence, a disposition, and the working tree's counts.
 */
export function RollbackDisclosure(props: RollbackDisclosureProps): React.JSX.Element {
  const { reading } = props;
  const resendSentence = resendSettlementSentence(reading.disposition);
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
      <div className="meridian-rollback__files">
        {/* The mount's own render and not an element built here: what a loader-backed
            body renders is the mount's decision — the settled body where its chunk has
            landed, the substrate's hidden reserved region where it has not — and this
            component's job is to say which props it takes. */}
        {fileRestoreDisclosureMount.render({ result: props.result })}
      </div>
    </div>
  );
}
