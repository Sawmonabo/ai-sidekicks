// The one edge into the invite confirmation's chunk, and the only one that is
// asynchronous.
//
// `invite-confirmation-body.ts` is the chunk root and states why the card is off the
// initial import graph; this module is the half that stays ON it. It holds no invite
// knowledge and imports the card only as a TYPE — that line is erased by the compiler, so
// the sole runtime edge into the chunk is the `import()` below.
//
// A `LoadedLazyBody` rather than a `lazy()` of this module's own, because that class is
// already the console's one answer to a loader-backed body: one in-flight promise however
// many callers ask, one component identity so a host re-render does not remount the card
// while an act is unsettled, a fresh payload only where a load rejected so the error
// boundary's retry reaches a live loader, and the settled body rendered directly once the
// chunk has landed — which is what makes the OPEN warm here. The overlay renders this
// mount from the moment a prompt exists, and a prompt exists as soon as the notice is
// drawn, so the chunk is asked for a whole gesture before the press that opens the card
// and the person meets the settled body rather than a wait.
//
// ONE `const` AND NOT A MODULE-LEVEL `let`: the memo is the class's own private field,
// which is what `apps/desktop/AGENTS.md` §State and views asks for, and a window has
// exactly one deep-link lifecycle — the window overlay seat holds one occupant — so there
// is nothing to key the registration on.

import { LoadedLazyBody, reservedBodyRegion } from "../../seats/index.js";
import type { InviteConfirmationProps } from "./InviteConfirmation.js";

/**
 * What a pending confirmation stamps, so a refused capture says WHICH body was loading.
 *
 * Not a pane kind — this card is not a pane and is drawn in the window overlay seat the
 * deck knows nothing about — so the value is the body's own name.
 */
const INVITE_CONFIRMATION_PENDING_BODY = "invite-confirmation";

/** The confirmation, mounted from its chunk. The lifecycle overlay's one reader. */
export const inviteConfirmationMount: LoadedLazyBody<InviteConfirmationProps> = new LoadedLazyBody(
  () => import("./invite-confirmation-body.js"),
  () => reservedBodyRegion(INVITE_CONFIRMATION_PENDING_BODY),
);
