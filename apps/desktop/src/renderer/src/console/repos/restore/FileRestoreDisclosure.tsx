import { useId } from "react";
import { GLYPH_SIZE_CHROME } from "../../tokens/index.js";
import { Chip, DerivedFigure, Glyph, WireFigure, formatCount } from "../../primitives/index.js";
import type { ChipTone } from "../../primitives/index.js";
import type { RollbackInterventionResult } from "@ai-sidekicks/contracts";
import { RestoreEnumerationLists } from "./RestoreEnumerationLists.js";
import { restoreEnumerations } from "./restore-enumerations.js";

/** One rollback disposition, as the contract's own union names them. */
type RollbackDisposition = RollbackInterventionResult["disposition"];

/** What a disposition means for the working tree, and how loudly it reads. */
interface DispositionPresentation {
  /** Amber means a person is needed, red means something failed, everything else neutral. */
  readonly tone: ChipTone;
  /** What happened to the files, in one sentence. Never the disposition name reworded. */
  readonly meaning: string;
}

/**
 * Total over the contract's nine dispositions by construction.
 *
 * `files-partially-restored` and `files-unrestored` carry deliberately different
 * sentences — the first says earlier effects are on disk, the second says the tree was
 * not touched — because that difference is the one this surface exists not to collapse.
 */
const DISPOSITION_PRESENTATION: Readonly<Record<RollbackDisposition, DispositionPresentation>> = {
  "files-restored": {
    tone: "neutral",
    meaning: "The working tree was restored to the target boundary.",
  },
  "conversation-only": {
    tone: "neutral",
    meaning: "The rewind moved the conversation only. No file was restored and none was touched.",
  },
  "files-partially-restored": {
    tone: "failure",
    meaning:
      "The restore sequence failed part way. It mutates incrementally, so every effect applied before the failing step is still on disk.",
  },
  "files-unrestored": {
    tone: "failure",
    meaning: "No file was restored. The working tree is as it was before the rewind was requested.",
  },
  "pause-only": {
    tone: "attention",
    meaning: "The run was paused and nothing was rewound. No file was touched.",
  },
  "nothing-applied": {
    tone: "attention",
    meaning: "Nothing was applied. No file was touched.",
  },
  "position-mismatch": {
    tone: "attention",
    meaning:
      "The run had moved past the requested position, so nothing was rewound and no file was touched.",
  },
  "boundary-diverged": {
    tone: "attention",
    meaning:
      "The target sits across a context-compaction boundary, so the rewind was refused before any mutation and no file was touched.",
  },
  "resend-unapplied": {
    tone: "failure",
    meaning:
      "The rewind succeeded and the replacement message was not sent. The restore DID mutate the working tree, so its enumerations stand.",
  },
};

/**
 * What an empty pair means, and why it is not an all-clear.
 *
 * Two sentences, one per arm of the ambiguity the contract states. `failedStep` is
 * what separates them, which is why the degraded arm names it and the applied arm
 * does not claim it.
 */
const EMPTY_ENUMERATIONS_WITH_STEP =
  "Both enumerations are empty. That is not an all-clear: it reads either as a failure before any mutation, or as a rewrite that had nothing to enumerate. The failed step above is what names how far the sequence got.";

const EMPTY_ENUMERATIONS_APPLIED =
  "Both enumerations are empty. That is not an all-clear: it reads either as a restore that overwrote nothing ignored and diverged no submodule, or as a whole-worktree rewrite that had nothing to enumerate.";

/** What the boundary arm says when the crossing carries no position to compare against. */
const NO_BOUNDARY_POSITION_COPY =
  "The compaction row carries no position, so it classifies as crossing for every target of this run.";

export interface FileRestoreDisclosureProps {
  readonly result: RollbackInterventionResult;
  /** Open one enumerated path in the diff pane. Absent where no diff exists for it. */
  readonly onOpenPath?: ((path: string) => void) | undefined;
}

export function FileRestoreDisclosure(props: FileRestoreDisclosureProps): React.JSX.Element {
  const { result } = props;
  const headingId = useId();
  const presentation = DISPOSITION_PRESENTATION[result.disposition];
  const enumerations = restoreEnumerations(result);

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

      {result.disposition === "files-partially-restored" ? (
        <p className="meridian-restore-disclosure__step">
          Failed at <WireFigure value={result.failedStep} />
        </p>
      ) : null}

      {result.disposition === "boundary-diverged" ? (
        <p className="meridian-restore-disclosure__step">
          Confirmed at <DerivedFigure text={formatCount(result.confirmedPosition)} />;{" "}
          {result.newestBoundaryPosition === null ? (
            // Required-and-nullable on the wire, and the null is a STATED cause rather
            // than a missing value: a position-less compaction row. Rendering it as an
            // absence would report the console's silence as the daemon's.
            <DerivedFigure text={NO_BOUNDARY_POSITION_COPY} />
          ) : (
            <>
              newest boundary at <DerivedFigure text={formatCount(result.newestBoundaryPosition)} />
            </>
          )}
        </p>
      ) : null}

      {enumerations === undefined ? (
        // No enumerations on this disposition, and that is the type's answer rather
        // than a read that came back empty — so it is stated, not drawn as two empty
        // lists that would read as "nothing was mutated".
        <p className="meridian-restore-disclosure__no-enumerations">
          This disposition mutated no file, so it carries no path enumerations.
        </p>
      ) : (
        <RestoreEnumerationLists
          enumerations={enumerations}
          emptyCopy={
            result.disposition === "files-partially-restored"
              ? EMPTY_ENUMERATIONS_WITH_STEP
              : EMPTY_ENUMERATIONS_APPLIED
          }
          onOpenPath={props.onOpenPath}
        />
      )}
    </section>
  );
}
