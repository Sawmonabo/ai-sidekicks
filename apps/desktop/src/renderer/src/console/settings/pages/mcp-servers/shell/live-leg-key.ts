// The identity one LIVE LEG is keyed by — the session it runs in and the binding that
// session holds open — encoded once for both lists that render one.
//
// THE REGISTERED IDENTITY IS THE PAIR, NEVER THE BINDING HANDLE. `bindingId` names one
// live binding inside one session, and one configuration backs however many concurrent
// sessions there are, so two legs of one server can arrive carrying the same
// `bindingId` under two different `sessionId`s — which is exactly why both leg shapes
// name both members. A list keyed on `bindingId` alone gives those two rows ONE React
// identity, and React then reuses the wrong row the moment a leg is added, removed, or
// reordered: one session's status renders beside the other session's id, on a surface
// whose whole reason for keeping the per-leg grain is that two legs may honestly
// disagree.
//
// AND THE PAIR IS ENCODED RATHER THAN JOINED, through the console's one tuple encoder.
// Both members are wire strings this console does not author, so a separator either of
// them may contain is not a separator — the defect `core/structural-key.ts` exists to
// close, one axis along from the scope-qualified binding key.
//
// HERE RATHER THAN INSIDE EITHER LIST, because two of them render a leg: the per-binding
// legs on a row, and the per-leg outcomes a mutation answers with. Two spellings would
// drift the moment a member moved, and the two lists would then key one leg two ways.
// It stays inside this shell rather than beside the leg SHAPES, because both readers are
// this directory's and the whole directory is deleted by the task that fills the slot.

import { structuralKey } from "../../../../core/index.js";

/**
 * The two members that identify one live leg.
 *
 * Declared structurally rather than as a union of the two wire shapes that carry it:
 * a leg status and a live application result are different values about the same leg,
 * and what this function needs from either is the pair.
 */
export interface McpLiveLegIdentity {
  readonly sessionId: string;
  readonly bindingId: string;
}

/** The string one live leg is keyed by. */
export function mcpLiveLegKeyOf(leg: McpLiveLegIdentity): string {
  return structuralKey([leg.sessionId, leg.bindingId]);
}
