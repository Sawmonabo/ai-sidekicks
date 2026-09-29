// Under what sandbox, network, and credential boundary the work actually ran.
//
// The session composer settles what a posture surface may claim: it renders the run's
// stamped execution posture from the `run.running` row's `executionPosture` member — a
// projection of the daemon's stamp and never of a request, because no wire member
// carries a posture request — and it offers no mutation. The five Nevers below are this
// component's own reading of that. The shape is the provider-driver contract's
// `ExecutionPosture`, imported rather than restated — it is one of the few things on
// this surface the wire actually registers today, and its two cross-field invariants
// (`allowedDomains` only under `allowed-domains`, `credentialPolicyRef` required on
// both sandboxed modes and forbidden under `trusted`) are encoded structurally there,
// so this component renders them rather than re-checking them.
//
// IT LIVES IN `primitives/` because its inputs are the contract's posture shape, this
// family's own figures, and one `core/` threshold — nothing above `core/` — so this is
// the lowest family that owns them.
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
//     read the two together.
//   • `credentialPolicyRef` is shown as the reference itself. Expanding it into a
//     deny-list would reveal the installation.
//   • A broad allow-list is never presented as safety; the copy says so where the
//     list is broad.
//
// There is no mutation. No posture verb exists anywhere in the corpus: posture is
// supplied at spawn and stamped on `run.running`, and a posture change is a new run.

import { type ExecutionPosture as WireExecutionPosture } from "@ai-sidekicks/contracts";

import { Nothing } from "@renderer/console/primitives/absence/index.js";
import { Chip, DerivedFigure } from "@renderer/console/primitives/figures/index.js";
import { PostureFacts } from "./PostureFacts.js";
import { POSTURE_ABSENT_DETAIL, POSTURE_ENFORCEMENT_CAVEAT } from "./posture-copy.js";
import type { PostureReading } from "./posture-reading.js";

import "./ExecutionPostureCard.css";

/** What the card shows: a posture, and whether it was stamped on a run or is an intent. */
export interface ExecutionPostureProps {
  readonly posture: WireExecutionPosture | undefined;
  readonly reading: PostureReading;
  /** The run this posture was stamped on, where the reading is `stamped`. */
  readonly runId?: string;
}

/** The execution boundary as an open card, or an inline notice when the posture is unknown. */
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
  return (
    <div className={`meridian-posture meridian-posture--${props.reading}`}>
      {line}
      <PostureFacts posture={posture} />
      <p className="meridian-posture__caveat">{POSTURE_ENFORCEMENT_CAVEAT}</p>
    </div>
  );
}
