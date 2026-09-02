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

import { Chip, DerivedFigure, Nothing, WireFigure } from "../../primitives/index.js";
import { BROAD_ALLOW_LIST_THRESHOLD } from "./posture-bounds.js";

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

export interface ExecutionPostureProps {
  readonly posture: WireExecutionPosture | undefined;
  readonly reading: PostureReading;
  /** The run this posture was stamped on, where the reading is `stamped`. */
  readonly runId?: string;
}

export function ExecutionPostureChip(props: ExecutionPostureProps): React.JSX.Element {
  if (props.posture === undefined) {
    return (
      <Nothing
        kind="not-checked"
        placement="inline"
        title="Execution boundary unknown"
        detail="A posture is stamped when a run reaches running. A row that is not running, or one from before the posture was recorded, carries none — which is not the same as an unrestricted one."
      />
    );
  }
  const posture = props.posture;
  return (
    <div className={`meridian-posture meridian-posture--${props.reading}`}>
      <div className="meridian-posture__line">
        <Chip mono glyph="approval" label={posture.mode} />
        <Chip mono label={posture.networkAccess} />
        {props.reading === "intent" ? (
          <DerivedFigure text="Intent for the next run — not a stamped boundary" />
        ) : (
          <DerivedFigure text={props.runId === undefined ? "Stamped on a run" : "Stamped"} />
        )}
      </div>
      <dl className="meridian-posture__facts">
        {/* Always beside its mode: an empty list reads two opposite ways. */}
        <div className="meridian-posture__fact">
          <dt>Writable roots</dt>
          <dd>
            {posture.writableRoots.length === 0 ? (
              <DerivedFigure
                text={
                  posture.mode === "trusted"
                    ? "None recorded — no OS-enforced write constraint under this mode"
                    : "None — nothing is writable under this mode"
                }
              />
            ) : (
              <ul className="meridian-posture__roots">
                {posture.writableRoots.map((root) => (
                  <li key={root}>
                    <WireFigure value={root} />
                  </li>
                ))}
              </ul>
            )}
          </dd>
        </div>
        {posture.networkAccess === "allowed-domains" ? (
          <div className="meridian-posture__fact">
            <dt>Allowed domains</dt>
            <dd>
              <ul className="meridian-posture__domains">
                {posture.allowedDomains.map((domain) => (
                  <li key={domain}>
                    <WireFigure value={domain} />
                  </li>
                ))}
              </ul>
              {posture.allowedDomains.length >= BROAD_ALLOW_LIST_THRESHOLD ? (
                <p className="meridian-posture__caveat">
                  A broad allow-list is weak against domain fronting: traffic to an allowed name can
                  still reach somewhere else.
                </p>
              ) : null}
            </dd>
          </div>
        ) : null}
        {posture.profileName === undefined ? null : (
          <div className="meridian-posture__fact">
            <dt>Profile</dt>
            <dd>
              <WireFigure value={posture.profileName} />
            </dd>
          </div>
        )}
        {posture.mode === "trusted" ? null : (
          <div className="meridian-posture__fact">
            <dt>Credential policy</dt>
            <dd>
              <WireFigure value={posture.credentialPolicyRef} />
            </dd>
          </div>
        )}
      </dl>
      <p className="meridian-posture__caveat">
        A mode label does not imply uniform enforcement by the operating system. On the Claude leg
        enforcement is scoped to the Bash tool, and non-Bash tools are bound through the permission
        system instead.
      </p>
    </div>
  );
}
