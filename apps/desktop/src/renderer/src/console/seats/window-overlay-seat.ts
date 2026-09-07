// The window overlay seat: the one body a window mounts once, above every route.
//
// WHY A SEAT AND NOT A MOUNT INSIDE A SURFACE
//
// A deep-link invitation is about a session this window is NOT in, and it arrives on
// somebody else's schedule — before any session has been opened, on the sessions
// list, in settings. A lifecycle mounted inside a session view therefore has its
// feeds open only while that view happens to be on screen, so a first-time recipient
// following a link into a fresh window opens no channel at all and the invitation
// cannot surface. `Plan-023` T-023r-6-3 says the same thing from the other side: the
// confirmation is "hosted by the console frame rather than by a session view,
// because a deep link can fire before any session view is mounted".
//
// The frame cannot import the family that owns that body — a layer family importing
// a view family is an upward edge `structure:layering` fails — so the frame reads a
// seat and renders whatever is in it, exactly as the workspace reads the composer
// seat and the sidebar reads its sections. The registration is a CALL from the
// console's composition rather than a module side effect, for the reason
// `shell/index.ts` gives about the composer: a seat filled by whoever happened to
// import a file is a seat the real owner then collides with.
//
// ONE SLOT AND NOT A KEYED BOARD. Exactly one body is window-scoped in this console,
// and a board sized for a set that has one member is a set minted ahead of its
// second reader. `SingleSlotSeat` already carries the three properties this needs —
// the same owner may re-register, a different owner may not, and a refusal names
// both — so this module only fixes the props.
//
// WHAT THE FRAME OWES IT, AND WHY NAVIGATION IS AN ACTION RATHER THAN A ROUTE
//
// The overlay's terminal act is opening the session an acceptance just joined. Where
// a route goes is the frame's, not a view family's — so the frame hands DOWN the one
// action it wants performed and the body calls it, rather than a family reaching up
// for a store it has no business steering.

import { type ConsoleBridge } from "../bridge/index.js";
import { type FrameStore, type ModalSurfaceClaimAct } from "../store/index.js";
import { SingleSlotSeat } from "./single-slot-seat.js";

/** What the frame hands the window's overlay body on every render. */
export interface WindowOverlaySeatProps {
  /** The window's resolved bridge. The overlay's reads are bridge-scoped, not session-scoped. */
  readonly bridge: ConsoleBridge;
  /**
   * Open one session in this window.
   *
   * The frame's own navigation, handed down as an act. A body that reached for the
   * frame store instead would be a view family steering the window it is drawn in,
   * and an auxiliary window would have no way to hand it a different answer.
   */
  readonly openSession: (sessionId: string) => void;
  /**
   * Say that this body has a modal surface up, for exactly as long as it has one.
   *
   * An act for the same reason `openSession` is one, and needed for the same reason the
   * sign-in card and the walkthrough take the store-bound hook: a `modal="trap-focus"`
   * dialog traps the keyboard and leaves inerting the app root to the shell, so a card
   * that claims nothing is one a reader navigating by STRUCTURE walks straight behind.
   * The body drives it through `useModalSurfaceClaim`, which mints the claim id.
   *
   * The producer is `modalSurfaceClaimFor` and it lives in `store/` rather than beside
   * these props, unlike `sessionOpenerFor`: the register it binds is that family's own
   * and the store-bound hook there needs the same binding, so the lowest family that
   * needs it owns it and this seat spends only the type.
   */
  readonly claimModalSurface: ModalSurfaceClaimAct;
}

/** The window overlay body. Returns `React.ReactNode` so the frame renders it directly. */
export type WindowOverlayRenderer = (props: WindowOverlaySeatProps) => React.ReactNode;

/**
 * The frame's session navigation, bound to one window's route store.
 *
 * BESIDE THE PROPS RATHER THAN INSIDE THE FRAME, on the producer-and-consumer rule:
 * this module declares what the frame owes a window overlay, so the standard way of
 * producing it belongs here too — a mount composing the act inline would be the seam's
 * two halves written in two places.
 *
 * A plain function rather than a hook: it closes over the store and nothing else, so a
 * caller holds it with whatever cell it already keeps the store's derived values in.
 */
export function sessionOpenerFor(frameStore: FrameStore): (sessionId: string) => void {
  return (sessionId) => {
    frameStore.navigate({ kind: "workspace", sessionId });
  };
}

const windowOverlaySeat = new SingleSlotSeat<WindowOverlayRenderer>(
  "window overlay",
  "a window mounts one overlay; a second owner would make which one renders depend on import order",
);

/** The call the owning family's composition makes to fill the seat. */
export function registerWindowOverlaySeat(owner: string, render: WindowOverlayRenderer): void {
  windowOverlaySeat.register({ owner, render });
}

/**
 * Release the seat.
 *
 * Test scaffolding, and reachable only from this directory: the seat is module-scope,
 * so a case that filled it would leak into the next one. Nothing in the shipped tree
 * unfills a seat, which is why it is deliberately absent from the family door — a
 * door line no production module reads is what `architecture/barrel-census.test.ts`
 * fails.
 */
export function unregisterWindowOverlaySeat(): void {
  windowOverlaySeat.unregister();
}

/** The window's overlay body, or `undefined` while the seat is empty. */
export function windowOverlayRenderer(): WindowOverlayRenderer | undefined {
  return windowOverlaySeat.renderer();
}
