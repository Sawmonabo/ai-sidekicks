// The one edge into the sign-in card's chunk, and the only one that is asynchronous.
//
// `sign-in-card-body.ts` is the chunk root and states why the card is off the initial
// import graph; this module is the half that stays ON it. It holds no ceremony
// knowledge and imports the card only as a TYPE — that line is erased by the compiler,
// so the sole runtime edge into the chunk is the `import()` below.
//
// A `LoadedLazyBody` rather than a `lazy()` of this module's own, because that class is
// already the console's one answer to a loader-backed body: one in-flight promise
// however many callers ask, one component identity so a host re-render does not remount
// the card mid-ceremony, a fresh payload only where a load rejected so the error
// boundary's retry reaches a live loader, and the settled body rendered directly once
// the chunk has landed — so a card opened a second time never suspends at all.
//
// ONE `const` AND NOT A MODULE-LEVEL `let`: the memo is the class's own private field,
// which is what `apps/desktop/AGENTS.md` §State and views asks for, and a window has
// exactly one sign-in card so there is nothing to key the registration on.

import { LoadedLazyBody, reservedBodyRegion } from "../seats/index.js";
import type { SignInCardProps } from "./SignInCard.js";

/**
 * What a pending sign-in card stamps, so a refused capture says WHICH body was loading.
 *
 * Not a pane kind — this card is not a pane and is drawn inside an overlay the frame
 * knows nothing about — so the value is the body's own name.
 */
const SIGN_IN_CARD_PENDING_BODY = "sign-in-card";

/** The card, mounted from its chunk. The overlay's one reader. */
export const signInCardMount: LoadedLazyBody<SignInCardProps> = new LoadedLazyBody(
  () => import("./sign-in-card-body.js"),
  () => reservedBodyRegion(SIGN_IN_CARD_PENDING_BODY),
);
