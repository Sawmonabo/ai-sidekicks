// What one mint produced, held until a person puts it away.
//
// A HOOK RATHER THAN A RENDER BODY, on this package's standing rule and on the
// channel list's precedent beside it: what a minted invitation IS while it is on
// screen — the subject it belongs to and the link it carries — is one job, and
// `CreateInvite.tsx` does the other, which is drawing the form that produced it.
//
// NOTHING HERE HOLDS A TOKEN, AND THAT IS SETTLED UPSTREAM. `InviteCreateResponse`
// hands the plaintext back exactly once and only its hash is persisted
// (`Spec-002 §Token Security Properties`), so a surface holding one is holding
// something no later read can replace. `invite-mint.ts` reads the control-plane host
// before it mints and refuses the whole act when that read refuses, so a token exists
// only under a host that answered and its link is composed in the same turn — there
// is no unresolved arm for this holder to carry, and no host read for it to re-ask.
//
// THE REGISTER IS SUBJECT-SCOPED, for the reason the form beside it gives: an
// invitation belongs to the session it was minted in, so a window that moves must not
// show the arriving session what the one it left produced.

import { useCallback } from "react";

import { type ConsoleBridge } from "../../bridge/index.js";
import { useSubjectScopedState } from "../../store/index.js";
import { type MintedInvite } from "./InviteLinkReveal.js";

/** What the reveal reads, and the two things a person's presses ask of it. */
export interface MintedInviteHolder {
  /** The invitation on screen, or `undefined` where the form is showing instead. */
  readonly minted: MintedInvite | undefined;
  /** Put a settled mint on screen. */
  readonly hold: (minted: MintedInvite) => void;
  /** Put it away. The link goes with it, and nothing can show it again. */
  readonly release: () => void;
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

  const hold = useCallback(
    (settled: MintedInvite) => {
      publishMinted(settled);
    },
    [publishMinted],
  );

  const release = useCallback(() => {
    publishMinted(undefined);
  }, [publishMinted]);

  return { minted, hold, release };
}
