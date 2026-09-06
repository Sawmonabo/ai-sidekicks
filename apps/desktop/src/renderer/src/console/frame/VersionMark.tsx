// The version pair, and the banner when the two sides did not meet.
//
// ONE SURFACE WITH TWO DENSITIES, which is what the governing section describes rather
// than two surfaces that happen to sit together: collapsed it is the version pair, and
// one click away are the runtime's full supported-version set and the reading of what
// this console's own version is doing in it. The banner is the same surface raised —
// persistent, undismissable, and carrying the runtime's own reason as its code.
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
import type { ConsoleVersionMark, ConsoleVersionMismatch } from "./version-mark.js";

export interface VersionMarkProps {
  readonly mark: ConsoleVersionMark;
  /** Present exactly when the runtime refused the handshake. */
  readonly mismatch: ConsoleVersionMismatch | undefined;
}

/**
 * What the disclosure says about the console's own version, in the console's own words.
 *
 * Three sentences over the three states the membership can be in, and the third is why
 * it is not two: a runtime that published no set at all has told this console nothing
 * about its own version, which is a different fact from publishing a set this console
 * is missing from, and saying "not supported" for it would be the console asserting a
 * verdict nobody reached.
 */
function supportSentence(mark: ConsoleVersionMark): string {
  if (mark.consoleProtocolIsSupported === undefined) {
    return "The local runtime published no supported-version set.";
  }
  return mark.consoleProtocolIsSupported
    ? "This console's protocol is one the local runtime supports."
    : "This console's protocol is not in the set the local runtime published.";
}

/**
 * The mark. Rendered by the frame only on the settled arm — the decision is
 * `version-mark.ts`', beside the read whose phases it discriminates, so a component
 * that decided when it had something to say would be a second rule about whether the
 * console has heard back.
 */
export function VersionMark(props: VersionMarkProps): React.JSX.Element {
  return (
    <div className="meridian-version-mark">
      {props.mismatch === undefined ? null : (
        <RefusalBanner code={props.mismatch.reason} detail={props.mismatch.remedy} />
      )}
      <p className="meridian-version-mark__pair" role="note">
        Protocol <WireFigure value={props.mark.consoleProtocolVersion} /> here,{" "}
        <WireFigure value={props.mark.daemonProtocolVersion} /> on the local runtime.
      </p>
      <details className="meridian-version-mark__detail">
        <summary className="meridian-version-mark__summary">Supported versions</summary>
        <p className="meridian-version-mark__support">{supportSentence(props.mark)}</p>
        {props.mark.daemonSupportedProtocols.length === 0 ? null : (
          <ul className="meridian-version-mark__set">
            {props.mark.daemonSupportedProtocols.map((version) => (
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
