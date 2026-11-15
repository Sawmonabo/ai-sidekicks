// The refusal grammar: four shapes, one contract. Controls are offered; refusals are rendered,
// and never hide the control that produced them or re-derive the daemon's rule.
//
// The shape is a question of blast radius, not severity:
//
//   - inline: nothing changed. It sits beside the control, and the control stays.
//   - strip: a page's write or read failed and the control is as it was; it ends in `Try again`.
//   - card: the session's history now contains it, so it belongs in the transcript.
//   - banner: what the whole room can do has changed, so it spans the frame.
//
// No shape shows a code's wire spelling. The card and the banner draw a registered code and its
// reason as words (`RefusalWords`) over the refusing service's message, verbatim. The inline line
// draws those words alone, since the service's sentence can name an id, and a refusal the app
// wrote, under its own kebab-case code, as its sentence: a caller that words its own line gives it
// such a code. The strip draws the screen's own sentence for what failed, as its caller worded it.
// The code also rides on the root as `data-refusal-code` for diagnostics. The next move is the
// caller's `action`; the renderer computes no eligibility and so no remedy.

import type { Refusal } from "#renderer/lib/refusal/contract.js";
import type { RefusalExtensions } from "#renderer/lib/refusal/extensions.js";

/**
 * What every refusal shape renders, picked from `Refusal` so the shapes move with it and a
 * producer can spread one (`<RefusalCard {...refusal} />`). `origin` is left out: it is for
 * diagnostics, and only the code's words and the daemon's message go on screen.
 */
export interface RefusalProps extends Pick<Refusal, "code" | "detail"> {
  /** Which of the code's listed reasons applies, read as words after the code's. */
  readonly reason?: RefusalExtensions["reason"];
  /** The person's next move, when one exists. */
  readonly action?: React.ReactNode;
}
