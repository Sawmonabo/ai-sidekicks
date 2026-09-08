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
//   • AND COPYING IS PRESSED MORE THAN ONCE, so the newest press is the only one that
//     settles. The host's clipboard call is asynchronous and nothing orders its
//     answers, so two presses can settle in either order — and while the reveal held
//     "copied" and "the refusal" as two independent fields, a late rejection landed
//     "Copied" beside an error and a late success landed the opposite. Both are closed
//     here, and structurally rather than by care: the two facts are ONE value with
//     three arms, so a contradictory pair cannot be written; and every press claims a
//     round of the console's own generation latch under `supersedeAndClaim`, whose
//     rule is exactly this surface's — the answer a person is waiting on is the one
//     they asked for LAST — so a superseded attempt installs nothing when it lands.

import { useState } from "react";
import type { JoinMode } from "@ai-sidekicks/contracts";

import { type ConsoleRefusal } from "../../core/index.js";
import { consoleRefusalFrom } from "../../seats/index.js";
import { Chip, InlineRefusal, WireFigure, formatDateTime } from "../../primitives/index.js";
import { useGenerationLatch } from "../../store/index.js";

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

/**
 * What the copy attempt that still counts produced.
 *
 * ONE VALUE AND NOT TWO FIELDS, because the two facts it replaces are mutually
 * exclusive and were not held that way: a `Copied` flag beside a refusal has a fourth
 * state that means nothing — the clipboard both took the link and refused it — and
 * that state was reachable, since two presses settle in whatever order the host
 * answers them. Three arms make it unwritable.
 */
type InviteLinkCopyState =
  | { readonly kind: "untried" }
  | { readonly kind: "copied" }
  | { readonly kind: "refused"; readonly refusal: ConsoleRefusal };

/** Nothing pressed yet, or a fresh press whose answer has not landed. */
const COPY_UNTRIED: InviteLinkCopyState = { kind: "untried" };

/** The one key every press of this reveal's Copy control claims. */
const COPY_ATTEMPT_KEY = "copy";

/** Where a clipboard refusal came from, as the reader sees it. */
const COPY_REFUSAL_ORIGIN = "invite-link-copy";

export function InviteLinkReveal(props: InviteLinkRevealProps): React.JSX.Element {
  const { minted } = props;
  const [copyState, setCopyState] = useState<InviteLinkCopyState>(COPY_UNTRIED);
  // THE SUBJECT IS THE MINTED INVITATION, which is what a press is about: the register
  // is held weakly, a new mint is a new subject with its own round, and the attempts
  // made against an invitation that has been put away can install nothing into the one
  // that replaced it.
  const copyAttempts = useGenerationLatch();

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
            // Taken BEFORE the call is put, and never refused: the newest press is the
            // intent, so whatever is outstanding is abandoned here rather than allowed
            // to answer for it. The control stays open on purpose — pressing again is
            // the ordinary way somebody checks a copy landed, and closing it would
            // make an unanswered clipboard call a control that never comes back.
            const attempt = copyAttempts.supersedeAndClaim(minted, COPY_ATTEMPT_KEY);
            // Neither arm of the previous answer survives a fresh press: it was about
            // an attempt this one supersedes, and leaving `Copied` up would report the
            // older press as the state of the newer one.
            setCopyState(COPY_UNTRIED);
            void props
              .onCopy(minted.link)
              .then(
                () => {
                  attempt.settle(() => {
                    setCopyState({ kind: "copied" });
                  });
                },
                (rejection: unknown) => {
                  // Rendered rather than swallowed: the link is still on screen and
                  // still selectable, so the person needs to know the copy did not
                  // happen rather than be told it did. Behind the same round as the
                  // success arm, so a rejection that lost the race says nothing over
                  // an answer that came after it.
                  attempt.settle(() => {
                    setCopyState({
                      kind: "refused",
                      refusal: consoleRefusalFrom(rejection, COPY_REFUSAL_ORIGIN),
                    });
                  });
                },
              )
              .finally(() => {
                // Total and idempotent: a superseded round no longer owns the key, so
                // this frees only the round that is still the live one.
                attempt.release();
              });
          }}
        >
          {copyState.kind === "copied" ? "Copied" : "Copy"}
        </button>
      </div>

      {copyState.kind === "refused" ? (
        <InlineRefusal code={copyState.refusal.code} detail={copyState.refusal.detail} />
      ) : null}

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
