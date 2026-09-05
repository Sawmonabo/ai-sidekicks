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
import { Glyph } from "./Glyph.js";
import { WireFigure } from "./WireFigure.js";
import { formatWireString } from "./wire-figures.js";

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

const REFUSAL_GLYPH_SIZE = 14;

/** Beside the control that was pressed. Nothing changed; the control stays. */
export function InlineRefusal(props: RefusalProps): React.JSX.Element {
  return (
    <span className="meridian-refusal meridian-refusal--inline" role="status">
      <Glyph name="alert" size={REFUSAL_GLYPH_SIZE} />
      <WireFigure value={props.code} />
      <span className="meridian-refusal__message">{formatWireString(props.detail)}</span>
      {props.action !== undefined ? (
        <span className="meridian-refusal__action">{props.action}</span>
      ) : null}
    </span>
  );
}

/** In the ledger, when the refusal is now part of what happened. */
export function RefusalCard(props: RefusalProps): React.JSX.Element {
  return (
    <div className="meridian-refusal meridian-refusal--card">
      <div className="meridian-refusal__head">
        <Glyph name="alert" size={REFUSAL_GLYPH_SIZE} />
        <WireFigure value={props.code} />
      </div>
      <p className="meridian-refusal__message">{formatWireString(props.detail)}</p>
      {props.action !== undefined ? (
        <div className="meridian-refusal__action">{props.action}</div>
      ) : null}
    </div>
  );
}

export interface RefusalBannerProps extends RefusalProps {
  /** Omit to make the banner undismissable — it clears when the condition does. */
  readonly onDismiss?: () => void;
}

/** Across the frame, when what the whole room can do has changed. */
export function RefusalBanner(props: RefusalBannerProps): React.JSX.Element {
  return (
    <div
      className="meridian-refusal meridian-refusal--banner"
      // Not a live region. The banner is inserted already carrying its text, which
      // most screen readers never announce, and the frame announces every raise
      // through the one `LiveAnnouncer` (`frame/banner-announcements.ts`). A
      // `role="status"` here would be a second, unreliable read of the same
      // sentence; the banner stays in the tree as a plain group carrying the code.
      role="group"
    >
      <Glyph name="alert" size={REFUSAL_GLYPH_SIZE} />
      <div className="meridian-refusal__body">
        <WireFigure value={props.code} />
        <span className="meridian-refusal__message">{formatWireString(props.detail)}</span>
      </div>
      {props.action !== undefined ? (
        <div className="meridian-refusal__action">{props.action}</div>
      ) : null}
      {props.onDismiss !== undefined ? (
        <button
          type="button"
          className="meridian-refusal__dismiss"
          onClick={props.onDismiss}
          aria-label="Dismiss this notice"
        >
          <Glyph name="close" size={REFUSAL_GLYPH_SIZE} />
        </button>
      ) : null}
    </div>
  );
}
