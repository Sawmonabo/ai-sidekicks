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
//   • A HOST THAT COULD NOT BE READ DOES NOT HIDE THE INVITATION. The mint
//     succeeded; what failed is the composition of the link. The identifier and the
//     terms stay on screen and the refusal says what is missing, which is a state a
//     person can act on — a guessed host would be a link that opens nothing and
//     looks exactly like one that works.

import { useState } from "react";
import type { JoinMode } from "@ai-sidekicks/contracts";

import { type ConsoleRefusal } from "../../core/index.js";
import { consoleRefusalFrom } from "../../seats/index.js";
import { Chip, InlineRefusal, WireFigure, formatDateTime } from "../../primitives/index.js";

/** The link, or the reason there is not one. */
export type MintedInviteLink =
  | { readonly status: "composed"; readonly url: string }
  | { readonly status: "refused"; readonly refusal: ConsoleRefusal };

/**
 * What one mint produced. Held only until a person puts it away.
 *
 * THE PLAINTEXT TOKEN IS DELIBERATELY NOT A MEMBER. The reveal renders it only
 * inside the link {@link MintedInviteLink} already carries, which is composed once
 * from the host read at the moment of the mint — so a second copy on this model
 * would be a plaintext credential held for the life of the reveal that nothing
 * reads, which is a longer life than the one thing that needs it.
 */
export interface MintedInvite {
  /** Wire-verbatim, from the create reply. */
  readonly inviteId: string;
  /** ISO 8601, wire-verbatim — the reply's own, not the one that was asked for. */
  readonly expiresAt: string;
  /** What this invitation grants. The caller's own request, echoed for the reader. */
  readonly joinMode: JoinMode;
  readonly link: MintedInviteLink;
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
  // Bound to a local `const` so the arm narrowed in the branch below is still
  // narrowed inside the press handler that branch creates. Read off `minted.link`
  // there instead and the handler would have to assert its own arm — an assertion is
  // a claim the compiler stops checking.
  const { link } = minted;

  return (
    <section className="meridian-invite-reveal" aria-label="The invitation you just created">
      <h4 className="meridian-invite-reveal__title">Send this link — it is shown once.</h4>

      <div className="meridian-invite-reveal__facts">
        <Chip label={minted.joinMode} mono tone="accent" />
        <WireFigure value={formatDateTime(minted.expiresAt)} title={minted.expiresAt} />
        <WireFigure value={minted.inviteId} />
      </div>

      {link.status === "refused" ? (
        <InlineRefusal code={link.refusal.code} detail={link.refusal.detail} />
      ) : (
        <div className="meridian-invite-reveal__link">
          <WireFigure value={link.url} />
          <button
            type="button"
            className="meridian-invite-reveal__copy"
            onClick={() => {
              setCopyRefusal(undefined);
              props.onCopy(link.url).then(
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
      )}

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
