// The banner the frame raises when this console and the local runtime did not meet.
//
// IT EXISTS ONLY ON THE REFUSED ARM. `Spec-023`'s version banner has two states and one
// of them draws nothing: compatible renders no element and reserves no space, and
// incompatible is persistent and read-only. So this component takes a mismatch and not
// a reading — there is no arrangement of props under which it renders a working window
// a version strip, because the props for one do not exist. The rule that decides WHICH
// windows get here lives beside the read, in `version-banner.ts`.
//
// IT IS THE REFUSAL GRAMMAR'S BANNER AND NOT A BOX OF ITS OWN. `RefusalBanner` is the
// third of the three refusal shapes, for a refusal that changes what the whole room can
// do — which is exactly what an incompatible handshake changes, since every mutating
// dispatch is refused while reads carry on. Passing no `onDismiss` is what makes it
// persistent: a claim that this window cannot change the session stops being true the
// moment it can be put away, and it has not stopped being true.
//
// AND IT OFFERS NO REMEDY CONTROL. Updating the console is an installer's act and
// updating the local runtime is an operator's; the banner names which one and executes
// neither. The disclosure below is a disclosure and not a remedy — it reveals what the
// runtime published and nothing about this window changes when it opens.
//
// THE VERSIONS ARE WIRE VALUES AND WEAR THE MONO PROVENANCE SIGNATURE. Every one of
// them was sent by one of the two builds, so each travels through `WireFigure` and the
// sentences around them are the console's own.

import { RefusalBanner, WireFigure } from "../primitives/index.js";
import type { ConsoleVersionMismatch } from "./version-banner.js";

export interface VersionBannerProps {
  /** The refused handshake. There is no prop for a handshake that succeeded. */
  readonly mismatch: ConsoleVersionMismatch;
}

/**
 * What the disclosure says when the refused ack published no supported set.
 *
 * Its own sentence rather than an empty list, because the two are different facts: a
 * runtime that listed nothing has told this console nothing about which versions it
 * speaks, and drawing an empty list for that would say it speaks none.
 */
const NO_PUBLISHED_SET_SENTENCE = "The local runtime published no supported-version set.";

/** Across the frame, for as long as the two builds disagree. */
export function VersionBanner(props: VersionBannerProps): React.JSX.Element {
  const supported = props.mismatch.daemonSupportedProtocols;
  return (
    <div className="meridian-version-banner">
      <RefusalBanner code={props.mismatch.reason} detail={props.mismatch.remedy} />
      <p className="meridian-version-banner__pair" role="note">
        Protocol <WireFigure value={props.mismatch.consoleProtocolVersion} /> here,{" "}
        <WireFigure value={props.mismatch.daemonProtocolVersion} /> on the local runtime.
      </p>
      <details className="meridian-version-banner__detail">
        <summary className="meridian-version-banner__detail-summary">Supported versions</summary>
        {supported === undefined ? (
          <p className="meridian-version-banner__support">{NO_PUBLISHED_SET_SENTENCE}</p>
        ) : (
          <ul className="meridian-version-banner__set">
            {supported.map((version) => (
              <li key={version}>
                <WireFigure value={version} />
              </li>
            ))}
          </ul>
        )}
      </details>
    </div>
  );
}
