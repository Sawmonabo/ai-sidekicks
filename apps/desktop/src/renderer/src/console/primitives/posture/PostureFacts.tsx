// The four conditional members of a stamped posture, as one definition list.
//
// Split from `ExecutionPostureChip.tsx` so the two presentations share one reading
// of the wire rather than one of them growing a shorter copy. A run row's
// disclosure and a pane's card render the SAME facts; what differs between them is
// how much of that is visible before a person asks, and that is the caller's
// choice, not a second set of rules about what a posture means.
//
// Every conditional in here is the contract's, restated nowhere:
//
//   • `writableRoots` is unconditional, because an empty list means two opposite
//     things and the mode beside it is what tells them apart.
//   • `allowedDomains` renders only under `allowed-domains`, where the list IS the
//     boundary. It is absent under `none` and under `full`.
//   • `credentialPolicyRef` renders on both sandboxed modes and never under
//     `trusted`, and it renders as the reference — never expanded into a deny-list,
//     which would disclose the installation.
//   • `profileName` renders when the stamp carried one.

import { type ExecutionPosture as WireExecutionPosture } from "@ai-sidekicks/contracts";

import { DerivedFigure } from "../DerivedFigure.js";
import { WireFigure } from "../WireFigure.js";
import { BROAD_ALLOW_LIST_THRESHOLD } from "../../core/index.js";

export function PostureFacts(props: { readonly posture: WireExecutionPosture }): React.JSX.Element {
  const { posture } = props;
  return (
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
  );
}
