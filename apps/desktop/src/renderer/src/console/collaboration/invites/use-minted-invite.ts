// What one mint produced, held until a person puts it away — and the one read that
// still has to answer before it can be sent.
//
// A HOOK RATHER THAN A RENDER BODY, on this package's standing rule and on the
// channel list's precedent beside it: what a minted invitation IS while it is on
// screen — the subject it belongs to, the token it may still be holding, and the host
// read that turns that token into a link — is one job, and `CreateInvite.tsx` does the
// other, which is drawing the form that produced it.
//
// THE TOKEN IS HELD, AND ONLY ON THE ARM THAT STILL NEEDS IT. `InviteCreateResponse`
// hands the plaintext token back exactly once and only its hash is persisted
// (`Spec-002 §Token Security Properties`). A host read that refused AFTER a successful
// mint therefore used to end an invitation's usable life at its first transient
// failure: the mint was real, the ledger carried the row, and the one string that
// composes the link had been dropped — no re-read, no remount and no later call could
// recover it, because the invites list deliberately carries no token. So the
// unresolved arm of `MintedInviteLink` carries it and a retry composes from it, while
// the composed arm carries none: the credential's life is exactly the window in which
// composing the link is still owed.
//
// A RETRY IS THE HOST READ AND NEVER A SECOND MINT. Re-minting would issue a second
// invitation for one intent, leaving the first standing in the ledger against a person
// who was only asking for the link they had already been promised.
//
// AND BOTH REGISTERS ARE SUBJECT-SCOPED, for the reason the form beside them gives: a
// minted token belongs to the session it was minted in, so a window that moves while a
// retry is unsettled must not show the arriving session what the one it left produced.

import { useCallback } from "react";

import { type ConsoleBridge } from "../../bridge/index.js";
import { useSubjectScopedState } from "../../store/index.js";
import { inviteLinkFrom, readControlPlaneHost } from "./invite-mint.js";
import { type MintedInvite } from "./InviteLinkReveal.js";

/** What the reveal reads, and the three things a person's presses ask of it. */
export interface MintedInviteHolder {
  /** The invitation on screen, or `undefined` where the form is showing instead. */
  readonly minted: MintedInvite | undefined;
  /** True while a retry's host read is out. */
  readonly isComposingLink: boolean;
  /** Put a settled mint on screen. */
  readonly hold: (minted: MintedInvite) => void;
  /** Put it away. The token goes with it, and nothing can show the link again. */
  readonly release: () => void;
  /** Ask the host again and compose the link from the token already held. */
  readonly composeLink: () => void;
}

export function useMintedInvite(
  bridge: ConsoleBridge,
  sessionId: string | undefined,
): MintedInviteHolder {
  const { value: minted, publish: publishMinted } = useSubjectScopedState<MintedInvite | undefined>(
    bridge,
    sessionId,
    () => undefined,
  );
  // Subject-scoped rather than a plain flag, so a window that re-addresses mid-read
  // arrives with its retry control open rather than inheriting a spinner over a read
  // that can no longer publish anything.
  const { value: isComposingLink, publish: publishComposing } = useSubjectScopedState<boolean>(
    bridge,
    sessionId,
    () => false,
  );

  const hold = useCallback(
    (settled: MintedInvite) => {
      publishMinted(settled);
    },
    [publishMinted],
  );

  const release = useCallback(() => {
    publishMinted(undefined);
  }, [publishMinted]);

  const composeLink = useCallback(() => {
    // Closed on every state with nothing to compose from — a composed link is
    // finished and an absent invitation holds no token — and single-flight against
    // the control's own re-entry, so a second press asks the host once.
    if (minted === undefined || minted.link.status !== "unresolved" || isComposingLink) {
      return;
    }
    const { inviteId } = minted;
    const { token } = minted.link;
    publishComposing(true);
    void readControlPlaneHost(bridge).then((host) => {
      publishComposing(false);
      // Against the invitation this retry was FOR. A person who put one away and
      // minted another while the read was out is looking at a different token, and
      // splicing this link onto it would show a link that opens the wrong invitation.
      publishMinted((held) =>
        held?.inviteId === inviteId ? { ...held, link: inviteLinkFrom(host, token) } : held,
      );
    });
  }, [bridge, isComposingLink, minted, publishComposing, publishMinted]);

  return { minted, isComposingLink, hold, release, composeLink };
}
