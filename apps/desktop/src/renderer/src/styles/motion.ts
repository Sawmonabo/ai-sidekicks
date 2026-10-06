// The app's one motion module: durations and the settle easing. Motion settles and never
// bounces. Reduced motion is collapsed to opacity by the generated sheet's own media block, so
// nothing here reads it, and no View Transitions wrapper exists because nothing starts one.
//
// Motion uses platform primitives (CSS transitions, `@starting-style`, the Web Animations API)
// with a spring written out as a `linear()` easing, and no animation library on the render path,
// where one would fight the virtualizer. No sampler ships: the spring's inputs are constants, so
// sampling it at every mount would recompute the same 106 characters.
//
// This file lives in `styles/` and carries no DOM type: the assets tier reads `styles/` from
// Node, where `Document` and `Window` do not exist.

/** The motion duration tokens, so a reader that names one is checked against the set. */
type MotionDurationToken = "motion-quick" | "motion-settle" | "motion-thread" | "motion-breath";

/**
 * Motion durations, in milliseconds: 120-180 ms for chrome, 240 ms for a settings page settling
 * in, and 1200 ms for one half of the breath a running thing's mark takes, slow enough to read as
 * alive rather than as an alarm. Here rather than in `palette.ts`, which answers "what color is
 * this?".
 */
export const MOTION_DURATIONS_MS: Readonly<Record<MotionDurationToken, number>> = {
  "motion-quick": 120,
  "motion-settle": 180,
  "motion-thread": 240,
  "motion-breath": 1200,
};

/**
 * The app's one settle easing: the chrome spring sampled into a `linear()` the compositor
 * runs under the platform's own timing, written out because the spring's inputs are constants.
 * It is emitted under the name every stylesheet reads, `--meridian-ease-settle`.
 */
export const CHROME_SETTLE_EASING: string =
  "linear(0, 0.3554, 0.7127, 0.8883, 0.9596, 0.986, 0.9953, " +
  "0.9985, 0.9995, 0.9998, 0.9999, 1, 1, 1, 1, 1, 1)";
