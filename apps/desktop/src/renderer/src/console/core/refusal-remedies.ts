// What a person can DO about a named daemon refusal, and which shape it calls for.
//
// `Spec-023 §Console Design (Meridian)` rule 9 fixes what reaches the screen from
// the refusal itself: the code verbatim in mono, the daemon's own sentence
// unparaphrased, and no sentence of the console's explaining what the daemon meant.
// It also gives every rendering an `action` slot — "the operator's next move, when
// one exists" — and that slot is the console's to fill. This table is what fills it,
// and the distinction it keeps is the one rule 9 draws: the daemon says what
// happened, and the console says what to do next.
//
// SO NOTHING HERE PARAPHRASES A `detail`. Each entry names an act — edit the line,
// send again, wait for the bindings — and where the honest next move is "nothing,
// this is over", it says that and the surface withdraws the control instead of
// leaving a button that cannot work.
//
// ONE TABLE RATHER THAN COPY AT EACH SURFACE, because these codes reach more than
// one. `session.not_found` can answer almost anything; `intervention.idempotency_conflict`
// refuses a composer steer and a runs-pane control alike. Two surfaces writing their
// own words for one code is how a person learns a remedy on one screen and does not
// recognise it on the next.
//
// AND EVERY KEY IS A CODE `error-contracts.md` ACTUALLY REGISTERS, which is checked
// against that file rather than asserted here: a key the wire never sends answers
// `undefined` forever, so the copy behind it reaches nobody and nothing reports it.
// `run.version_conflict` was exactly that — console vocabulary that appears in no
// registry, the corpus routing a stale comparand to the intervention lifecycle state
// `expired` instead — so its row is gone rather than kept for symmetry.
//
// IT IS KEYED ON THE WIRE STRING AND ANSWERS `undefined` FOR EVERY OTHER CODE, which
// is deliberate: a `Record` over a closed union would make this module import each
// producer's vocabulary and invert the DAG — `core/` is the bottom family and knows
// none of them — and, worse, a total table would need an entry for every registered
// code in the corpus, most of which have no next move beyond what the daemon already
// said. An unlisted code renders exactly as it does today, with no action beside it.

/** Which of rule 9's three shapes a refusal's blast radius calls for. */
export type RefusalRendering = "inline" | "card" | "banner";

/** What a surface does about one named refusal, beyond rendering the daemon's words. */
export interface RefusalRemedy {
  /**
   * The shape this refusal calls for, by blast radius rather than by severity.
   *
   * A surface that has only one rendering ignores it; a surface that can raise a
   * banner reads it and raises one, which is how `session.not_found` reaches the
   * workspace from a control that was pressed in one pane.
   */
  readonly rendering: RefusalRendering;
  /** The operator's next move, in the console's own words. Never a paraphrase. */
  readonly nextMove: string;
  /**
   * Whether the request this refusal names is finished.
   *
   * `true` means there is nothing left for the control that produced it to do — the
   * decision was answered elsewhere, the message was already sent, the run is gone
   * — so the surface withdraws the control rather than offering an act that can only
   * be refused again. `false` means the same act may work, so the control stays.
   */
  readonly settled: boolean;
}

/**
 * The next move for each named refusal, keyed on the wire code verbatim.
 *
 * Every entry is a code the corpus registers and a surface in this console actually
 * reaches. A code with no entry is not an omission to be filled for symmetry: it is
 * a refusal whose daemon sentence is the whole of what the console can honestly say.
 */
const REFUSAL_REMEDIES: Readonly<Record<string, RefusalRemedy>> = {
  // The retry carried a key already spent on different text. The daemon applied the
  // first body and nothing new went out, so the remedy is a new message rather than
  // another attempt at this one.
  "intervention.idempotency_conflict": {
    rendering: "inline",
    nextMove:
      "This was already sent with different text. Nothing new went out — send the line again as a new message.",
    settled: true,
  },
  // The run left the daemon. Whatever the surface last saw of it is the last thing
  // anyone will see; the row stays and stops claiming to be live.
  "run.not_found": {
    rendering: "card",
    nextMove:
      "This run is gone from the daemon. What is shown is the last state the stream reported.",
    settled: true,
  },
  // The session itself is gone, so every control in this window is answering about
  // something that is not there. That is a banner rather than a line beside one
  // button.
  "session.not_found": {
    rendering: "banner",
    nextMove:
      "This session is gone from this node. Open it again from the session list, or open another one.",
    settled: true,
  },
  // Somebody else answered the request. The next projection read drops the card, so
  // the two actions come off it now rather than staying pressable.
  "approval.already_resolved": {
    rendering: "card",
    nextMove: "Somebody else answered this request. It leaves the list on the next read.",
    settled: true,
  },
  // No event was appended, so the goal did not change at all. The surface names the
  // bindings the daemon reported failing beside this.
  "session.goal_delivery_failed": {
    rendering: "inline",
    nextMove:
      "No event was appended, so the goal did not change. Try again once every named binding is answering.",
    settled: false,
  },
};

/** The next move for this code, or nothing where the daemon's sentence is the whole of it. */
export function refusalRemedyFor(code: string): RefusalRemedy | undefined {
  return Object.hasOwn(REFUSAL_REMEDIES, code) ? REFUSAL_REMEDIES[code] : undefined;
}

/** Every code this table answers for, as a set a test can walk. */
export const REMEDIED_REFUSAL_CODES: readonly string[] = Object.keys(REFUSAL_REMEDIES);
