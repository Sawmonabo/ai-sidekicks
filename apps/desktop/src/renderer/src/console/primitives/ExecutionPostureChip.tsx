// Under what sandbox, network, and credential boundary the work actually ran.
//
// `Spec-023 §Signature Feature Composition Sketches`' Session Composer settles what
// a posture surface may claim — it renders "the run's stamped execution posture from
// the `run.running` row's `executionPosture` member … a projection of the daemon's
// stamp and never of a request, because no wire member carries a posture request",
// and it "offers no mutation". The five Nevers below are this component's own
// reading of that. The shape is the provider-driver contract's `ExecutionPosture`,
// imported rather than restated — it is one of the
// few things on this surface the wire actually registers today, and its two
// cross-field invariants (`allowedDomains` only under `allowed-domains`,
// `credentialPolicyRef` required on both sandboxed modes and forbidden under
// `trusted`) are encoded structurally there, so this component renders them rather
// than re-checking them.
//
// IT LIVES IN `primitives/` BECAUSE TWO VIEW FAMILIES RENDER IT. The runs pane puts
// one on every run row and the approvals pane puts one under each run a pending
// decision names, and those two families sit beside each other in the DAG: neither
// may import the other, so a component either family owned would have to be copied
// to reach the second. Its inputs are the contract's posture shape, this family's
// own figures, and one `core/` threshold — nothing above `core/` — so this is the
// lowest family that owns them.
//
// FIVE NEVERS, EACH ONE A LINE OF CODE THAT IS ABSENT:
//
//   • No composite "security level". A posture satisfies a floor only if every axis
//     independently meets its floor, so a single score would be a fabrication.
//   • An absent posture is UNKNOWN, never `trusted`. Absence means a non-running row
//     or pre-amendment history, and reading it as the most permissive mode would
//     turn missing evidence into a claim.
//   • `writableRoots` never appears without its `mode`, because an empty list means
//     two opposite things — nothing writable under `readonly-sandboxed`, no
//     OS-enforced write constraint under `trusted` — and audit reconstruction has to
//     read the two together. THE ROW PRESENTATION HOLDS THIS TOO: its closed summary
//     carries the roots COUNT beside the mode, so the two are never apart at any
//     density, and opening it is what expands the count into the paths.
//   • `credentialPolicyRef` is shown as the reference itself. Expanding it into a
//     deny-list would reveal the installation.
//   • A broad allow-list is never presented as safety; the copy says so where the
//     list is broad.
//
// There is no mutation. No posture verb exists anywhere in the corpus: posture is
// supplied at spawn and stamped on `run.running`, and a posture change is a new run.

import { useState } from "react";
import { type ExecutionPosture as WireExecutionPosture } from "@ai-sidekicks/contracts";

import { Chip } from "./Chip.js";
import { DerivedFigure } from "./DerivedFigure.js";
import { Nothing } from "./Nothing.js";
import { PostureFacts } from "./PostureFacts.js";
import { formatCount } from "./wire-figures.js";

/**
 * Which kind of posture reading this is.
 *
 * `stamped` is a fact about a run that happened. `intent` is a projection of
 * configured intent for the NEXT run. The two are kept visibly distinct because no
 * wire member carries an agent-level or composer-level posture — the sketch's
 * "never of a request" — and a chip that looked identical would imply one had been
 * enforced.
 */
export type PostureReading = "stamped" | "intent";

/**
 * How much of the posture is visible before a person asks for the rest.
 *
 * `card` is the pane presentation: every fact open, because the surface exists to
 * answer this question. `row` is the per-run presentation: mode, network and the
 * writable-root count visible, the rest one disclosure away — a run list carries one
 * of these per row and a list of open definition lists is not a list of runs.
 *
 * It is a presentation and never a subset: both arms render the same
 * {@link PostureFacts}, so the row cannot quietly drop a member the card shows.
 */
export type PosturePresentation = "card" | "row";

export interface ExecutionPostureProps {
  readonly posture: WireExecutionPosture | undefined;
  readonly reading: PostureReading;
  /** The run this posture was stamped on, where the reading is `stamped`. */
  readonly runId?: string;
  /** Defaults to the open card; a run row asks for `row`. */
  readonly presentation?: PosturePresentation;
}

/** The absent arm's sentence, in one place because both presentations take it. */
const POSTURE_ABSENT_DETAIL =
  "A posture is stamped when a run reaches running. A row that is not running, or one from before the posture was recorded, carries none — which is not the same as an unrestricted one.";

/** The enforcement caveat the corpus states, rendered wherever the facts are. */
const POSTURE_ENFORCEMENT_CAVEAT =
  "A mode label does not imply uniform enforcement by the operating system. On the Claude leg enforcement is scoped to the Bash tool, and non-Bash tools are bound through the permission system instead.";

export function ExecutionPostureChip(props: ExecutionPostureProps): React.JSX.Element {
  if (props.posture === undefined) {
    return (
      <Nothing
        kind="not-checked"
        placement="inline"
        title="Execution boundary unknown"
        detail={POSTURE_ABSENT_DETAIL}
      />
    );
  }
  const posture = props.posture;
  const line = (
    <div className="meridian-posture__line">
      <Chip mono glyph="approval" label={posture.mode} />
      <Chip mono label={posture.networkAccess} />
      {props.reading === "intent" ? (
        <DerivedFigure text="Intent for the next run — not a stamped boundary" />
      ) : (
        <DerivedFigure text={props.runId === undefined ? "Stamped on a run" : "Stamped"} />
      )}
    </div>
  );
  if (props.presentation === "row") {
    return (
      <PostureRow posture={posture} reading={props.reading}>
        {line}
      </PostureRow>
    );
  }
  return (
    <div className={`meridian-posture meridian-posture--${props.reading}`}>
      {line}
      <PostureFacts posture={posture} />
      <p className="meridian-posture__caveat">{POSTURE_ENFORCEMENT_CAVEAT}</p>
    </div>
  );
}

/**
 * The row density: the line and the root count open, the facts one click away.
 *
 * The facts are RENDERED ONLY WHILE OPEN, the shape `PathEnumeration` beside this
 * file takes and for the same reason: a closed `<details>` hides its children
 * without stopping React from building them, so a list of runs would pay for one
 * definition list per row to show nobody. The count in the summary is what makes the
 * closed state honest — the roots are never absent from a reading of the mode, they
 * are summarised.
 */
function PostureRow(props: {
  readonly posture: WireExecutionPosture;
  readonly reading: PostureReading;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  const [isOpen, setIsOpen] = useState(false);
  const rootCount = props.posture.writableRoots.length;
  return (
    <details
      className={`meridian-posture meridian-posture--row meridian-posture--${props.reading}`}
      onToggle={(event) => {
        setIsOpen(event.currentTarget.open);
      }}
    >
      <summary className="meridian-posture__summary">
        {props.children}
        <DerivedFigure
          text={
            rootCount === 0
              ? props.posture.mode === "trusted"
                ? "no writable root recorded"
                : "nothing writable"
              : `${formatCount(rootCount)} writable`
          }
        />
      </summary>
      {isOpen ? (
        <>
          <PostureFacts posture={props.posture} />
          <p className="meridian-posture__caveat">{POSTURE_ENFORCEMENT_CAVEAT}</p>
        </>
      ) : null}
    </details>
  );
}
