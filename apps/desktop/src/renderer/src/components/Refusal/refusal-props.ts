// The refusal grammar: three shapes, one contract. Controls are offered; refusals are rendered,
// and never hide the control that produced them or re-derive the daemon's rule.
//
// The shape is a question of blast radius, not severity:
//
//   - inline: nothing changed. It sits beside the control, and the control stays.
//   - card: the session's history now contains it, so it belongs in the transcript.
//   - banner: what the whole room can do has changed, so it spans the frame.
//
// Every shape shows the code in mono (a wire string) and the daemon's message verbatim, never
// paraphrased or shortened. The next move is the caller's `action`; the renderer computes no
// eligibility and so no remedy.

import type { Refusal } from "@renderer/lib/refusal.js";

/**
 * What every refusal shape renders, picked from `Refusal` so the shapes move with it and a
 * producer can spread one (`<RefusalCard {...refusal} />`). `origin` is left out: it is for
 * diagnostics, and only the code and the daemon's message go on screen.
 */
export interface RefusalProps extends Pick<Refusal, "code" | "detail"> {
  /** The person's next move, when one exists. */
  readonly action?: React.ReactNode;
}
