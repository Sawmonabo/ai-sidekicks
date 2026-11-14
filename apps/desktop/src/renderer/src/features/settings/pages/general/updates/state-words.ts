// The words the update block draws for the updater's state, its path and its reported failure.
import type { UpdateFailedStep, UpdateState } from "#shared/preload-api.js";

import { figurePart, type FigureSentencePart } from "#renderer/lib/figure-sentence.js";
import { formatDate, formatDateTime, formatZonedDateTime } from "#renderer/lib/wire/figures.js";
import { UPDATER_UNREACHABLE_DETAIL } from "#renderer/store/update/unreachable.js";

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
 * What a failure the updater reports reads as on screen, by the step that failed. Its own message
 * is never drawn: it goes to the diagnostic log, since it is the updater's wording and may name a
 * path or a stack.
 */
export const UPDATE_FAILED_DETAIL: Readonly<Record<UpdateFailedStep, string>> = {
  check: UPDATER_UNREACHABLE_DETAIL.check,
  download: UPDATER_UNREACHABLE_DETAIL.download,
  verify: "The update could not be verified and was not installed.",
  restart: UPDATER_UNREACHABLE_DETAIL.restart,
};

/**
 * The step of {@link UPDATE_PATH_STEPS} a failed step leaves the path on, or `undefined` for a
 * failed check, which found no update to draw a path for.
 */
const UPDATE_PATH_STEP_BY_FAILED_STEP: Readonly<
  Record<UpdateFailedStep, (typeof UPDATE_PATH_STEPS)[number] | undefined>
> = {
  check: undefined,
  download: "Downloading",
  verify: "Checking the signature…",
  restart: RESTART_TO_FINISH,
};

/** The step of {@link UPDATE_PATH_STEPS} the state is on, or `undefined` with no update found. */
export function updatePathStepOf(
  state: UpdateState,
): (typeof UPDATE_PATH_STEPS)[number] | undefined {
  switch (state.status) {
    case "idle":
    case "checking":
      return undefined;
    case "available":
      return "Checked";
    case "downloading":
      return "Downloading";
    case "verifying":
      return "Checking the signature…";
    case "ready":
      return RESTART_TO_FINISH;
    case "error":
      return UPDATE_PATH_STEP_BY_FAILED_STEP[state.step];
  }
}

/**
 * The line each settled arm draws, as words and figures, which is also what a screen reader is
 * told. The download's percent is drawn beside its line and never in it, so a push per percentage
 * point is not read out.
 */
export function updateStateLine(
  state: Exclude<UpdateState, { readonly status: "error" }>,
  runningVersion: string,
  clockLocale: string,
): readonly FigureSentencePart[] {
  switch (state.status) {
    case "idle":
      return ["The newest version seen is ", figurePart("wire", runningVersion), "."];
    case "checking":
      return ["Checking for updates…"];
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
      return ["Ready to install — ", figurePart("wire", state.version), ". Restart to finish."];
  }
}

/** The line under the idle line naming when the last check finished. */
export function lastCheckedLine(
  lastCheckedAt: string,
  clockLocale: string,
): readonly FigureSentencePart[] {
  return [
    "Last checked ",
    figurePart(
      "wire",
      formatDateTime(lastCheckedAt, clockLocale),
      formatZonedDateTime(lastCheckedAt, clockLocale),
    ),
    ".",
  ];
}
