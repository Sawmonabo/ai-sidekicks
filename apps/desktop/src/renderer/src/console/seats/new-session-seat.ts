// The seat the composed new-session draft is mounted through, and what it hands back.
//
// TWO VIEW FAMILIES MEET HERE, WHICH IS WHY THE CONTRACT IS NOT IN EITHER OF THEM.
// The control is the workspace family's — it composes a draft, holds it on the bridge
// it would send through, and issues the three calls a first send coalesces. The place
// it is mounted is the sessions family's all-sessions destination. Neither may import
// the other, so the composition root names which component fills the place and this
// module says what that component's props ARE. Spelled in both families instead, the
// two spellings drift and the one that goes stale is the one nothing reads.
//
// THE CALLBACK CARRIES A SESSION ID AND NOTHING ELSE, and that is the seam's whole
// shape. What the console DOES with a session it just started — open its store, stamp
// the origin only this window can report, declare the node's directory stale, navigate
// — is `sessions/acts/session-start.ts`, and it is the sessions family's because every
// one of those four steps names a store or a route the workspace family cannot reach.
// The draft knows the id and stops there; a control that carried the settlement itself
// would be a second copy of an act that already has one home.

import type { ComponentType } from "react";

import type { ConsoleBridge } from "../bridge/index.js";

/** What the sessions destination hands the composed draft control. */
export interface NewSessionControlProps {
  /**
   * The transport the draft composes against, and sends through.
   *
   * The draft is held ON this bridge, so a replacement discards it: a send addressed
   * to a transport that has been retired either never lands or lands somewhere this
   * console will not read again.
   */
  readonly bridge: ConsoleBridge;
  /**
   * The session a completed send produced, told once, at the moment it completed.
   *
   * ON THE COMPLETED ARM ALONE. A send that stopped part way created a session too,
   * and the draft deliberately stays on screen for it — the refusal names what could
   * not be done and the person presses Send again, which resumes at the first call
   * that has not been made. Settling there would navigate away from the sentence that
   * says what to do next, and would stamp a start that has not happened yet.
   *
   * Needs no stable identity: the control reads the callback that was committed at
   * the moment it settles rather than the one an effect closed over.
   */
  readonly onSessionCreated: (sessionId: string) => void;
  /**
   * Ask the destination to re-read the node's session directory.
   *
   * The one act a draft can still offer after a create whose reply this build could
   * not read: a session may exist under a name nothing here holds, and the directory
   * is what would answer. It is the SESSIONS family's act for the same reason the
   * settlement above is — the read is addressed at the node and its staleness is
   * declared through a seat this family owns, neither of which the workspace family
   * may reach.
   *
   * Needs no stable identity, on `onSessionCreated`'s own terms: it is read from a
   * press rather than from a dependency array.
   */
  readonly onSessionDirectoryRecheck: () => void;
}

/**
 * The composed-draft control as the composition root hands it over.
 *
 * The COMPONENT rather than a built element: which component mounts is the root's
 * decision, and which props it takes is the mounting family's — the bridge and the
 * settlement both come off a surface context the root cannot reach when it registers.
 */
export type NewSessionControlComponent = ComponentType<NewSessionControlProps>;
