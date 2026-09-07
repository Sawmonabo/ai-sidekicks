// The one moment the link exists.
//
// `InviteCreateResponse` hands the plaintext token back exactly once and only its
// hash is persisted (`Spec-002 §Token Security Properties`), so this is not a
// confirmation that a row was added — it is the only place the thing a person
// actually sends can be read. Everything about the shape follows from that.
//
//   • IT DOES NOT FADE. Putting it away is a press with a sentence on it, because
//     the sentence is true: nothing can show the link again.
//   • THE LINK RENDERS IN FULL, selectable, rather than as a copy button alone. A
//     host that refuses the clipboard is a real state (`native.copyToClipboard`
//     rejects and the refusal is rendered), and a person looking at a link they can
//     read still has a way to send it.
//   • THE LINK IS ALWAYS THERE, AND THAT IS A PROPERTY OF THE ACT RATHER THAN OF
//     THIS SURFACE. `invite-mint.ts` reads the control-plane host BEFORE it mints and
//     refuses the whole act when that read refuses, so an invitation only ever exists
//     under a host that answered and its link is composed in the same turn its reply
//     lands in. There is no half-composed reveal to render, no token held on screen
//     waiting for a second read, and no retry control here: a host that could not be
//     read is a press that created nothing, reported on the form's own send control.

import { useState } from "react";
import type { JoinMode } from "@ai-sidekicks/contracts";

import { type ConsoleRefusal } from "../../core/index.js";
import { consoleRefusalFrom } from "../../seats/index.js";
import { Chip, InlineRefusal, WireFigure, formatDateTime } from "../../primitives/index.js";

/**
 * What one mint produced. Held only until a person puts it away.
 *
 * THE PLAINTEXT TOKEN IS NOT A MEMBER OF THIS MODEL, and nothing above the
 * composition holds one: the link is the only form of the credential that leaves
 * `invite-mint.ts`, and it is complete by the time this value exists.
 */
export interface MintedInvite {
  /** Wire-verbatim, from the create reply. */
  readonly inviteId: string;
  /** ISO 8601, wire-verbatim — the reply's own, not the one that was asked for. */
  readonly expiresAt: string;
  /** What this invitation grants. The caller's own request, echoed for the reader. */
  readonly joinMode: JoinMode;
  /** `https://<control-plane-host>/invite/<token>`, composed and complete. */
  readonly link: string;
}

export interface InviteLinkRevealProps {
  readonly minted: MintedInvite;
  /** Put the link on the clipboard. The host's own refusal is this surface's to render. */
  readonly onCopy: (link: string) => Promise<void>;
  /** Put the invitation away. The token is unrecoverable afterwards. */
  readonly onDone: () => void;
}

export function InviteLinkReveal(props: InviteLinkRevealProps): React.JSX.Element {
  const { minted } = props;
  const [copyRefusal, setCopyRefusal] = useState<ConsoleRefusal | undefined>(undefined);
  const [isCopied, setIsCopied] = useState(false);

  return (
    <section className="meridian-invite-reveal" aria-label="The invitation you just created">
      <h4 className="meridian-invite-reveal__title">Send this link — it is shown once.</h4>

      <div className="meridian-invite-reveal__facts">
        <Chip label={minted.joinMode} mono tone="accent" />
        <WireFigure value={formatDateTime(minted.expiresAt)} title={minted.expiresAt} />
        <WireFigure value={minted.inviteId} />
      </div>

      <div className="meridian-invite-reveal__link">
        <WireFigure value={minted.link} />
        <button
          type="button"
          className="meridian-invite-reveal__copy"
          onClick={() => {
            setCopyRefusal(undefined);
            props.onCopy(minted.link).then(
              () => {
                setIsCopied(true);
              },
              (rejection: unknown) => {
                // Rendered rather than swallowed: the link is still on screen and
                // still selectable, so the person needs to know the copy did not
                // happen rather than be told it did.
                setCopyRefusal(consoleRefusalFrom(rejection, "invite-link-copy"));
              },
            );
          }}
        >
          {isCopied ? "Copied" : "Copy"}
        </button>
      </div>

      {copyRefusal === undefined ? null : (
        <InlineRefusal code={copyRefusal.code} detail={copyRefusal.detail} />
      )}

      <div className="meridian-invite-reveal__acts">
        <button type="button" className="meridian-invite-reveal__done" onClick={props.onDone}>
          Done — I have the link
        </button>
      </div>

      <p className="meridian-invite-reveal__footnote">
        The invitation stays in the ledger below, but the link does not: nothing can show it again.
      </p>
    </section>
  );
}
