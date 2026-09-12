// The console's one motion module.
//
// Design-language rule 5 fixes what motion may do — settle, never bounce; 120 to 180 ms
// ease-out; a 2 px rise on entrances; a 240 ms line-grow for attribution threads;
// `prefers-reduced-motion` collapsing everything to opacity — and the console's motion
// rules fix what may implement it: platform primitives (CSS transitions,
// `@starting-style`, View Transitions, the Web Animations API) with OUR OWN spring
// sampler emitting `linear()` easings, and no animation library on the render path.
//
// That row is a rejection with a reason, and the reason is what the sampler is: an
// animation library on the render path fights the virtualizer. The measured
// alternatives each lose on a different axis — one re-measures layout per render
// and costs tens of kilobytes in its layout shape, one runs its own frame loop
// and never reaches the Web Animations API at all, one attaches a per-child
// observer and a poll per element. What is actually needed from all of that is a
// function from spring constants to a string.
//
// AND THE SAMPLER IS NOT IN THIS FILE, WHICH IS THE POINT OF THE CONSTANT BELOW.
// The console made exactly one call to it and passed two module-scope constants, so
// the closed-form solution, its three damping branches, and the sample loop were on
// the initial import graph to recompute the same 106 characters at every mount — a
// pure function of constants is a constant, and this one is 625 bytes of shipped
// arithmetic larger than the string it answers. The string is emitted below and the
// sampler is `spring-sampler.test-support.ts`, which nothing that ships imports.
// Nothing about the curve is taken on trust: `motion.test.ts` holds the constant to
// `sampleSpringEasing(CHROME_SETTLE_SPRING)`, so the two cannot drift, and every
// claim rule 5 makes about the shape is still asserted against the sampler there.
//
// WHY THIS LIVES IN `tokens/` AND CARRIES NO DOM TYPE. `tokens/` is a VOCABULARY
// family: the assets tier reads it from Node to check the generated sheet against
// the palette it came from, so a module here that names `Document` or `Window`
// puts types into a program that has neither. Everything below is therefore a plain
// value, and this module reaches no global, which is also why its own tests need no
// DOM.
//
// WHAT THIS MODULE PUBLISHES IS WHAT THE SHEET SPENDS, AND NOTHING ELSE. The scale
// and the easing both left `palette.ts`, which answers "what colour is this?" and
// had been answering "how long does this take?" beside it. What did NOT come with
// them is a reduced-motion allowance vocabulary and a View Transitions wrapper that
// this branch shipped with no caller: nothing in the console starts a view
// transition, and reduced motion is collapsed by the generated sheet's own media
// block rather than read in TypeScript by anybody. They are deleted rather than
// tagged, and they come back with the surface that needs them — which is also when
// their shape can be decided against a real caller instead of a guess.

/**
 * Motion durations, in milliseconds. Rule 5: settles, never bounces — 120-180 ms
 * for chrome, 240 ms for an attribution thread drawing itself.
 *
 * Here rather than in `palette.ts`, which answers "what colour is this?": a
 * duration is not a colour, and a motion scale living one file away from the
 * easing that shapes it left this module's own first line false.
 */
export const MOTION_DURATIONS_MS: Readonly<Record<string, number>> = {
  "motion-quick": 120,
  "motion-settle": 180,
  "motion-thread": 240,
};

/**
 * The console's ONE settle easing: the chrome spring, sampled into the `linear()`
 * a compositor can run under the platform's own timing.
 *
 * Written out rather than sampled at startup because both of the sampler's inputs
 * are constants, so the sampled string is one too — see the header for what that
 * bought. It is NOT a hand-drawn curve and is not maintained by hand: the numbers
 * below are what `sampleSpringEasing(CHROME_SETTLE_SPRING)` answers, and
 * `motion.test.ts` fails if they ever stop being, so editing a spring constant
 * turns that test red rather than leaving the sheet quietly describing a different
 * spring.
 *
 * It is emitted under the name every stylesheet already reads: a second token
 * holding the sampled curve left the hand-written cubic answering
 * `var(--meridian-ease-settle)` everywhere while the spring the rule asks for was
 * declared under a name no sheet spent.
 */
export const CHROME_SETTLE_EASING: string =
  "linear(0, 0.3554, 0.7127, 0.8883, 0.9596, 0.986, 0.9953, 0.9985, 0.9995, 0.9998, 0.9999, 1, 1, 1, 1, 1, 1)";
