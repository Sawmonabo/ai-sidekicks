// What a person can do about a named daemon refusal, and which rendering it calls for.
//
// The daemon says what happened; this table says what to do next, and never paraphrases a
// `detail`. Where the honest next move is "nothing, this is over", the component withdraws the
// control. Keys are wire codes verbatim; an unlisted code answers `undefined` and renders with no
// action. Keyed by string, not a `Record` over a union, because `lib/` sits below every producer.

/**
 * Which of the three refusal shapes — inline under the control, a card in the transcript,
 * a banner across the session — a refusal's blast radius calls for.
 */
export type RefusalRendering = "inline" | "card" | "banner";

/**
 * What a component does about one named refusal beyond rendering the daemon's words: the
 * app-wide entry, or a feature table's entry with the exclusive cases one code stands for.
 */
export type RefusalRemedy = AppRefusalRemedy | CasedRefusalRemedy;

/** The app-wide entry: the rendering a refusal calls for, its next move, and whether it is done. */
export interface AppRefusalRemedy {
  /**
   * The rendering this refusal calls for, by blast radius rather than severity. A component
   * with one rendering ignores it; one that can raise a banner does, so `session.not_found`
   * reaches the session screen from a control pressed in one pane.
   */
  readonly rendering: RefusalRendering;
  /** The person's next move, in the app's own words. Never a paraphrase. */
  readonly nextMove: string;
  /**
   * Whether the request this refusal names is finished. `true` means the control has nothing
   * left to do, so the component withdraws it; `false` means the same act may work, so it stays.
   */
  readonly settled: boolean;
}

/**
 * A feature table's entry: the next move, and the exclusive cases a person chooses between where
 * one code stands for more than one situation. `distinctions` is empty when there is one move.
 */
export interface CasedRefusalRemedy {
  readonly nextMove: string;
  readonly distinctions: readonly string[];
}

/** The next move for each named refusal; a code with no entry needs only the daemon's sentence. */
const REFUSAL_REMEDIES: Readonly<Record<string, AppRefusalRemedy>> = {
  // The retry reused a key already spent on different text; the daemon applied the first body,
  // so the remedy is a new message.
  "intervention.idempotency_conflict": {
    rendering: "inline",
    nextMove:
      "This was already sent with different text. Nothing " +
      "new went out — send the line again as a new message.",
    settled: true,
  },
  // The run left the daemon; the row stays and stops claiming to be live.
  "run.not_found": {
    rendering: "card",
    nextMove:
      "This run is gone from the background service. What " +
      "is shown is the last state the stream reported.",
    settled: true,
  },
  // The session is gone, so every control in the window answers about nothing: a banner, not a
  // line beside one button.
  "session.not_found": {
    rendering: "banner",
    nextMove:
      "This session is gone from the background service. Open " +
      "it again from the session list, or open another one.",
    settled: true,
  },
  // Another device answered; the next projection read drops the card, so its actions come off now.
  "approval.already_resolved": {
    rendering: "card",
    nextMove: "This was answered on another linked device. It leaves the list on the next read.",
    settled: true,
  },
};

/** The next move for this code, or nothing where the daemon's sentence is the whole of it. */
export function refusalRemedyFor(code: string): AppRefusalRemedy | undefined {
  return Object.hasOwn(REFUSAL_REMEDIES, code) ? REFUSAL_REMEDIES[code] : undefined;
}
