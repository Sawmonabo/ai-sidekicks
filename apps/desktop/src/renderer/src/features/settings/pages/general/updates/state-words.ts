// The words the update block draws for the updater's state, its path and its reported failure.
import type { UpdateState } from "#shared/preload-api.js";

import { figurePart, type FigureSentencePart } from "#renderer/lib/figure-sentence.js";
import { formatDate, formatZonedDateTime } from "#renderer/lib/wire/figures.js";

/**
 * What the updater reporting a failure reads as on screen. Its own message is never drawn: it goes
 * to the diagnostic log, since it is the updater's wording and may name a path or a stack.
 */
export const UPDATE_FAILED_DETAIL = "The update could not be verified and was not installed.";

/** The whole update path, in order, drawn as numbered steps once an update has been found. */
export const UPDATE_PATH_STEPS = [
  "Checked",
  "Downloading",
  "Checking the signature…",
  "Ready to install",
  "Restart to finish",
] as const;

/** The press that restarts into a downloaded update, which is also the path's last step. */
export const RESTART_TO_FINISH: (typeof UPDATE_PATH_STEPS)[4] = UPDATE_PATH_STEPS[4];

/**
 * The step of {@link UPDATE_PATH_STEPS} each arm is on, or `undefined` for an arm with no update
 * found yet. A failure is the signature's step, the one its sentence names.
 */
export const UPDATE_PATH_STEP_BY_STATUS: Readonly<
  Record<UpdateState["status"], (typeof UPDATE_PATH_STEPS)[number] | undefined>
> = {
  idle: undefined,
  checking: undefined,
  available: "Checked",
  downloading: "Downloading",
  verifying: "Checking the signature…",
  error: "Checking the signature…",
  ready: RESTART_TO_FINISH,
};

/**
 * The line each settled arm draws, as words and figures, which is also what a screen reader is
 * told. A check under way keeps the idle line, since the press it follows is the news. The
 * download's percent is drawn beside its line and never in it, so a push per percentage point is
 * not read out.
 */
export function updateStateLine(
  state: Exclude<UpdateState, { readonly status: "error" }>,
  runningVersion: string,
  clockLocale: string,
): readonly FigureSentencePart[] {
  switch (state.status) {
    case "idle":
    case "checking":
      return ["The newest version seen is ", figurePart("wire", runningVersion), "."];
    case "available":
      return [
        "Update available — ",
        figurePart("wire", state.version),
        ", released ",
        figurePart(
          "wire",
          formatDate(state.releasedAt, clockLocale),
          formatZonedDateTime(state.releasedAt, clockLocale),
        ),
        ".",
      ];
    case "downloading":
      return ["Downloading…"];
    case "verifying":
      return ["Checking the signature…"];
    case "ready":
      return state.version === undefined
        ? ["Ready to install. Restart to finish."]
        : ["Ready to install — ", figurePart("wire", state.version), ". Restart to finish."];
  }
}
