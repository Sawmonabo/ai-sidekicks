// The refusal grammar — three shapes, one contract.
//
// `Spec-023 §Console Design (Meridian)` rule 9: "Controls are offered; refusals are
// rendered, in one of three shapes — **inline** on the control that was pressed …
// as a **card** in the ledger when the refusal changes history, or as a **banner**
// across the workspace when it changes what the whole room can do. A refusal never
// hides the control that produced it and never re-derives the daemon's rule."
//
// Which shape a call site picks is a question about blast radius, not about
// severity: what did this refusal change for whom?
//
//   • inline  — nothing changed. The act did not happen; the operator can try
//               something else. It sits beside the control, and the control stays.
//   • card    — the session's history now contains this refusal. It belongs in the
//               ledger with everything else that happened.
//   • banner  — what the whole room can do has changed. It spans the frame.
//
// The three are three modules, one component each, and what they SHARE is here so
// that it is declared once: a shape that grew its own props would be the second
// vocabulary this contract exists to prevent, and it would drift silently, because
// each shape is rendered by different callers.
//
// Two things every shape does the same way, because they are the rule and not a
// stylistic choice:
//
//   1. **The code is mono, the message is verbatim.** The code is a wire string and
//      wears the provenance signature (rule 4). The daemon's message text is shown
//      exactly as sent — the console does not paraphrase it, shorten it, or add a
//      sentence of its own explaining what the daemon "meant". Rule 9's own wording
//      puts the code in mono and the message verbatim, and that asymmetry is kept:
//      a paragraph set in mono is a paragraph nobody reads.
//   2. **The next move is the caller's to supply.** `action` is a slot, not a
//      derivation. The renderer never computes eligibility, so it never computes a
//      remedy either.

import type { ConsoleRefusal } from "../core/index.js";

/**
 * What every refusal shape renders, PICKED from the one refusal value rather than
 * re-declared beside it.
 *
 * These props used to spell out their own `code: string; detail: string`, which is
 * `core/refusal.ts`'s shape written a second time — so a rename there would have
 * left this file compiling against a field the console no longer produces. Picking
 * makes the three renderers move with the value: a producer holding a
 * `ConsoleRefusal` spreads it (`<RefusalCard {...refusal} />`) and a producer
 * holding loose strings still passes them.
 *
 * `origin` is deliberately NOT picked. It exists so a refusal that surfaces three
 * layers from where it was raised still names its author, which is a fact for the
 * diagnostic band and the tripwire record — and rule 9 fixes what reaches the
 * screen at the code and the daemon's message. Rendering a third string here would
 * be the console adding a sentence of its own, which the same rule forbids.
 */
export interface RefusalProps extends Pick<ConsoleRefusal, "code" | "detail"> {
  /** The operator's next move, when one exists. */
  readonly action?: React.ReactNode;
}

// NO GLYPH SIZE IS DECLARED HERE. The alert every shape leads with is chrome inside
// a frame, so the three read as one grammar by taking `GLYPH_SIZE_CHROME` from
// `tokens/glyphs.ts` — the console's one home for that size — rather than by this
// module holding a copy the pane chrome would then have to agree with.
