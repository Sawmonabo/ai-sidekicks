// The diagnostics page's words and tones for the daemon's closed vocabularies.
//
// One table per vocabulary, each total over a set declared in `bridge/growth-values/`
// and never widened here. Total because the compiler is what enforces it: a fourth
// health state or a fifth redaction bucket added upstream is a missing key in this
// file rather than a blank cell on screen, which is the only way a page over closed
// wire vocabularies stays honest without anybody remembering to check it.
//
// THE WORDS ARE PRESENTATION AND THE VALUES ARE THE WIRE'S. A component's state
// reaches the screen through this table so the page reads in sentences; the state
// itself is never rewritten, never folded, and never inferred from a neighbouring
// reading. Where a wire string has no entry here at all — a failure category, a run
// state, a blocking reason — it is rendered verbatim in mono through `WireFigure`,
// because a vocabulary the corpus leaves open is one this console must not pretend to
// know the whole of.

import type { ChipTone } from "../../../primitives/index.js";
import type {
  GrowthHealthState,
  GrowthRecoveryAction,
  GrowthRedactionBucket,
} from "../../../bridge/index.js";
import type { SettingsConfirmationTone } from "../../shared/SettingsConfirmation.js";

/** The chip tone each health state wears. `blocked` is the console's failure tone. */
export const HEALTH_STATE_TONES: Readonly<Record<GrowthHealthState, ChipTone>> = {
  healthy: "neutral",
  degraded: "attention",
  blocked: "failure",
};

/** How each health state reads in a sentence. */
export const HEALTH_STATE_WORDS: Readonly<Record<GrowthHealthState, string>> = {
  healthy: "Healthy",
  degraded: "Degraded",
  blocked: "Blocked",
};

/**
 * What each diagnostic bucket holds, in a person's words.
 *
 * The bucket NAMES are the wire's and are rendered verbatim beside these; this column
 * says what the material is, which the identifier does not. A bucket added upstream
 * lands here as a compile error rather than as an unexplained row.
 */
export const REDACTION_BUCKET_DESCRIPTIONS: Readonly<Record<GrowthRedactionBucket, string>> = {
  driver_raw_events: "The frames a provider process wrote, as they arrived.",
  command_output: "What commands printed while they ran.",
  tool_traces: "The calls a run made to its tools, and what came back.",
  reasoning_detail: "A provider's own account of how it reached an answer.",
};

/** How each recovery action is offered, and what pressing it agrees to. */
export interface RecoveryActionCopy {
  /** The button's word. */
  readonly label: string;
  /** The confirmation's heading. */
  readonly confirmTitle: string;
  /** What the action does, in the confirmation body. */
  readonly consequence: string;
  /** The tone the trigger and the confirming button wear. */
  readonly tone: SettingsConfirmationTone;
}

/**
 * The three the request admits, and only those.
 *
 * Total over `GrowthRecoveryAction`, which is the point: the prompt maps the wire's own
 * action vocabulary to build its control set, so a control exists exactly where a wire
 * value does. The inspect reply's `escalate` suggestion has no entry because it has no
 * request to send, and it reaches the screen as guidance text instead.
 *
 * `abandon` is the destructive tone because it is the one that ends the run's work
 * rather than redirecting it; `retry` and `interrupt` both leave a run the daemon can
 * still be asked about.
 */
export const RECOVERY_ACTION_COPY: Readonly<Record<GrowthRecoveryAction, RecoveryActionCopy>> = {
  retry: {
    label: "Try again",
    confirmTitle: "Ask this machine to try the run again?",
    consequence:
      "The node re-attempts the work that stalled. Anything the run had already finished stays finished.",
    tone: "primary",
  },
  interrupt: {
    label: "Interrupt",
    confirmTitle: "Interrupt this run?",
    consequence:
      "The turn in flight is stopped. The run keeps everything it has already produced and stops where it is.",
    tone: "neutral",
  },
  abandon: {
    label: "Abandon",
    confirmTitle: "Abandon this run?",
    consequence:
      "The node stops working on this run and does not pick it up again. What it produced stays in the session; the work it had left does not happen.",
    tone: "destructive",
  },
};
