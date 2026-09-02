// The file half of a rewound run: what a rollback did to the working tree, said out
// loud on every disposition that touched it.
//
// `Spec-023 §Console Design (Meridian)` §10.5's job: "Make a rollback that touched the
// working tree legible on the artifact and run record, so no surface hides a restore
// that mutated files." Four things here are decisions rather than implementation:
//
// 1. THIS RENDERS A REGISTERED WIRE TYPE, NOT A FIXTURE. `RollbackInterventionResult`
//    is in `packages/contracts/src/runControl.ts` — the design table calls the restore
//    disclosure a fixture, and the contract has since landed, so this file consumes the
//    real discriminated union and the compiler holds it to the nine dispositions. A
//    tenth disposition fails to compile here rather than rendering as a blank card.
//
// 2. THE TWO ENUMERATIONS ARE NEVER SILENT, AND THE TYPE IS WHY. `Spec-010
//    §Turn-Boundary Snapshots` makes `overwrittenIgnoredPaths` and `divergentGitlinks`
//    REQUIRED and empty-when-none on every disposition that carries them, so absence is
//    a parse failure rather than a reading. `restoreEnumerations` below narrows on the
//    union rather than probing for the fields, which is that guarantee spent rather
//    than re-derived: the three dispositions that carry them are the three the type
//    says carry them.
//
// 3. BOTH LISTS EMPTY IS NOT AN ALL-CLEAR, AND THE COPY SAYS SO. The contract gives the
//    empty pair two readings — a failure before any mutation, and a whole-worktree
//    rewrite that had nothing to enumerate — and `failedStep` is what names how far the
//    sequence got. So the empty case renders a sentence, never a checkmark and never
//    nothing.
//
// 4. NOTHING IS OFFERED. This is a read surface over a result the rollback intervention
//    already returned; there is no control on it. Each enumerated path may open into
//    the diff pane where a diff exists, and that is a navigation the MOUNTING surface
//    supplies — the disclosure never reaches for a pane itself.
//
// NEVER, from the same section, and each is a property of THIS file:
//   • `files-partially-restored` is never collapsed into `files-unrestored`. They are
//     separate arms of the presentation table below with separate sentences, because
//     the sequence mutates incrementally and a late failure leaves earlier effects on
//     disk. Hiding that would mask file loss.
//   • No snapshot ref is presented as a branch. Nothing in this file renders a ref at
//     all — the enumerations are filesystem paths and are labelled as paths.
//   • The nine dispositions, their state mapping, and the `resendDisposition` axis are
//     chapter 7's run-control surface. This file fixes only where the FILE half is
//     disclosed, which is why it takes a result rather than an intervention.

import { useId } from "react";

import {
  Chip,
  DerivedFigure,
  Glyph,
  Nothing,
  WireFigure,
  formatCount,
} from "../primitives/index.js";
import type { ChipTone } from "../primitives/index.js";
import type { RollbackInterventionResult } from "@ai-sidekicks/contracts";

/** The glyph size every head in this surface draws at, matching the family's cards. */
const RESTORE_GLYPH_SIZE = 14;

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
 * not touched — because that difference is the one §10.5 forbids collapsing.
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

/** The two never-silent enumerations, carried together because they are read together. */
interface RestoreEnumerations {
  readonly overwrittenIgnoredPaths: readonly string[];
  readonly divergentGitlinks: readonly string[];
}

/**
 * The enumerations, where the disposition carries them.
 *
 * Narrowed on the discriminant rather than probed for the fields: the contract types
 * both as required on exactly these three arms, so this switch spends that guarantee
 * instead of re-deriving it. `resend-unapplied` is here for the reason the contract
 * records — it DISPLACES a completed file leg, so dropping its enumerations would
 * silence an overwritten path in precisely the case where the tree was mutated.
 */
function restoreEnumerations(result: RollbackInterventionResult): RestoreEnumerations | undefined {
  switch (result.disposition) {
    case "files-restored":
    case "files-partially-restored":
    case "resend-unapplied":
      return {
        overwrittenIgnoredPaths: result.overwrittenIgnoredPaths,
        divergentGitlinks: result.divergentGitlinks,
      };
    default:
      return undefined;
  }
}

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
          <Glyph name="worktree" size={RESTORE_GLYPH_SIZE} />
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

/**
 * Both enumerations, always, in the density §10.5 fixes: counts on the face, lists one
 * click away.
 *
 * They render even at zero — that is what "never silent" means on this surface — and
 * the empty pair carries the sentence that stops it reading as an all-clear.
 */
function RestoreEnumerationLists(props: {
  readonly enumerations: RestoreEnumerations;
  readonly emptyCopy: string;
  readonly onOpenPath: ((path: string) => void) | undefined;
}): React.JSX.Element {
  const { enumerations } = props;
  const isEmptyPair =
    enumerations.overwrittenIgnoredPaths.length === 0 &&
    enumerations.divergentGitlinks.length === 0;
  return (
    <div className="meridian-restore-disclosure__enumerations">
      <PathEnumeration
        label="Overwritten ignored paths"
        paths={enumerations.overwrittenIgnoredPaths}
        onOpenPath={props.onOpenPath}
      />
      <PathEnumeration
        label="Divergent gitlinks"
        paths={enumerations.divergentGitlinks}
        onOpenPath={props.onOpenPath}
      />
      {isEmptyPair ? (
        <p className="meridian-restore-disclosure__not-all-clear">{props.emptyCopy}</p>
      ) : null}
    </div>
  );
}

/**
 * One enumeration: its count, then its paths.
 *
 * The count is always visible and the list is a `<details>` — §10.5's density note —
 * so a long enumeration costs one row until somebody opens it, which is what keeps
 * this surface inside its budget while closed.
 *
 * NO VIRTUALIZER, AND THE REASON IS NOT LAZINESS. §10.5's leverage note reaches for
 * `@tanstack/react-virtual`, which is a dependency of no package in this workspace;
 * the family's own diff pane virtualizes with an own-built row index because a diff
 * is a nested structure, and its flat changed-file list settles for a scroll
 * container past a threshold instead. This is the flat case, and the scroll container
 * would need a height bound that the sheet's own no-literal-lengths rule has no token
 * for — so an OPEN enumeration renders every path it holds. That is the residual, and
 * it is stated rather than hidden: the bound belongs with the token that would express
 * it, and neither is this file's to mint.
 */
function PathEnumeration(props: {
  readonly label: string;
  readonly paths: readonly string[];
  readonly onOpenPath: ((path: string) => void) | undefined;
}): React.JSX.Element {
  if (props.paths.length === 0) {
    return (
      <p className="meridian-restore-disclosure__count">
        {props.label} <DerivedFigure text={formatCount(0)} />{" "}
        <Nothing kind="empty" placement="inline" title="None enumerated." />
      </p>
    );
  }
  return (
    <details className="meridian-restore-disclosure__detail">
      <summary className="meridian-restore-disclosure__detail-summary">
        {props.label} <DerivedFigure text={formatCount(props.paths.length)} />
      </summary>
      <ul className="meridian-restore-disclosure__paths">
        {props.paths.map((path) => (
          <li key={path}>
            {props.onOpenPath === undefined ? (
              <WireFigure value={path} />
            ) : (
              <button
                type="button"
                className="meridian-restore-disclosure__path-link"
                onClick={() => props.onOpenPath?.(path)}
              >
                <WireFigure value={path} />
              </button>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}
