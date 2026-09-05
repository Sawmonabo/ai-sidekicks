// What the attachment picker knows, as a closed set of four phases.
//
// ITS OWN MODULE BECAUSE THE SEAT AND ITS ANSWER BOTH SPEAK IT. `AttachmentPickerSeat`
// advances the state and `AttachmentPickerAnswer` renders it; declaring it in either
// would make the other import from a module that imports it back, which is the cycle
// the layering gate refuses.
//
// AND IT IS A SET, NOT A PAIR OF BOOLEANS. "Nothing asked yet" and "asked and the
// daemon carried no answer" are different facts about the same picker, and a
// two-flag encoding makes the pair that means neither representable.

import type { ConsoleRefusal } from "../../../../console/core/index.js";

/** The picker's four phases. Every other combination is unrepresentable by construction. */
export type PickerState =
  | { readonly phase: "unasked" }
  | { readonly phase: "asking" }
  | { readonly phase: "refused"; readonly refusal: ConsoleRefusal }
  | {
      readonly phase: "offered";
      readonly contentTypes: readonly string[];
      readonly maximumByteLength: number;
    };

/** The state before anything was asked, and what a rebind returns the seat to. */
export const UNASKED: PickerState = { phase: "unasked" };
