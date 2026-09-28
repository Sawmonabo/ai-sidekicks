import { useId } from "react";
import { GLYPH_SIZE_CHROME } from "../../tokens/index.js";
import { Chip, Glyph } from "../figures/index.js";
import type { ChipTone } from "../figures/index.js";
import type { RollbackInterventionResult } from "@ai-sidekicks/contracts";

/** The rollback results this disclosure draws, as the contract's own union names them. */
type DisclosedRollbackResult = Extract<
  RollbackInterventionResult,
  {
    disposition:
      | "files-restored"
      | "conversation-only"
      | "files-unrestored"
      | "nothing-applied"
      | "resend-unapplied";
  }
>;

type RollbackDisposition = DisclosedRollbackResult["disposition"];

/** What a disposition means for the working tree, and how loudly it reads. */
interface DispositionPresentation {
  /** Amber means a person is needed, red means something failed, everything else neutral. */
  readonly tone: ChipTone;
  /** What happened to the files, in one sentence. Never the disposition name reworded. */
  readonly meaning: string;
}

/** Total over the dispositions this disclosure draws, by construction. */
const DISPOSITION_PRESENTATION: Readonly<Record<RollbackDisposition, DispositionPresentation>> = {
  "files-restored": {
    tone: "neutral",
    meaning: "The working tree was restored to the target boundary.",
  },
  "conversation-only": {
    tone: "neutral",
    meaning: "The rewind moved the conversation only. No file was restored and none was touched.",
  },
  "files-unrestored": {
    tone: "failure",
    meaning: "No file was restored. The working tree is as it was before the rewind was requested.",
  },
  "nothing-applied": {
    tone: "attention",
    meaning: "Nothing was applied. No file was touched.",
  },
  "resend-unapplied": {
    tone: "failure",
    meaning:
      "The rewind succeeded and the replacement message was not sent. " +
      "The restore DID mutate the working tree.",
  },
};

/** What the disclosure draws: one rollback result. */
export interface FileRestoreDisclosureProps {
  readonly result: DisclosedRollbackResult;
}

/**
 * What a rewind did to the working tree: the disposition and what it means for the files.
 *
 * @consumedBy the composer's undo readout
 */
export function FileRestoreDisclosure(props: FileRestoreDisclosureProps): React.JSX.Element {
  const { result } = props;
  const headingId = useId();
  const presentation = DISPOSITION_PRESENTATION[result.disposition];

  return (
    <section
      className="meridian-restore-disclosure"
      aria-labelledby={headingId}
      data-disposition={result.disposition}
    >
      <header className="meridian-restore-disclosure__head">
        <h4 className="meridian-restore-disclosure__heading" id={headingId}>
          <Glyph name="worktree" size={GLYPH_SIZE_CHROME} />
          Working tree
        </h4>
        <Chip tone={presentation.tone} label={result.disposition} mono />
      </header>
      <p className="meridian-restore-disclosure__meaning">{presentation.meaning}</p>
    </section>
  );
}
