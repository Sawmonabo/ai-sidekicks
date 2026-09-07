// What the frame's version banner says BEYOND its code and its remedy.
//
// IT EXISTS ONLY ON THE REFUSED ARM. `Spec-023`'s version banner has two states and one
// of them draws nothing: compatible renders no element and reserves no space, and
// incompatible is persistent and read-only. So this component takes a mismatch and not
// a reading — there is no arrangement of props under which it renders a working window
// a version strip, because the props for one do not exist. The rule that decides WHICH
// windows get here lives beside the read, in `version-banner.ts`.
//
// AND IT NO LONGER DRAWS THE REFUSAL ITSELF. `version-banner.ts` raises the mismatch
// into the frame store's banner list, so the code and the remedy are rendered by the
// one `RefusalBanner` `FrameChrome.tsx` renders for every banner and announced once by
// `banner-announcements.ts` — which is what a refusal drawn straight into the tree
// never was. This component is the SUPPLEMENT the frame renders beside that row: two
// facts a `FrameBanner` cannot carry, because that shape is store data and the store
// holds no React. Drawing the refusal here as well would put one code and one sentence
// on screen twice and announce them once.
//
// AND IT OFFERS NO REMEDY CONTROL. Updating the console is an installer's act and
// updating the local runtime is an operator's; the banner names which one and executes
// neither. The disclosure below is a disclosure and not a remedy — it reveals what the
// runtime published and nothing about this window changes when it opens.
//
// THE VERSIONS ARE WIRE VALUES AND WEAR THE MONO PROVENANCE SIGNATURE. Every one of
// them was sent by one of the two builds, so each travels through `WireFigure` and the
// sentences around them are the console's own.

import { WireFigure } from "../primitives/index.js";
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

/** Beside the frame's mismatch banner, for as long as the two builds disagree. */
export function VersionBanner(props: VersionBannerProps): React.JSX.Element {
  const supported = props.mismatch.daemonSupportedProtocols;
  return (
    <div className="meridian-version-banner">
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
