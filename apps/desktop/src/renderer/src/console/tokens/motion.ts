// The console's one motion module.
//
// `Spec-023 §Console Design (Meridian)` rule 5 fixes what motion may do — settle,
// never bounce; 120 to 180 ms ease-out; a 2 px rise on entrances; a 240 ms
// line-grow for attribution threads; `prefers-reduced-motion` collapsing
// everything to opacity — and `§Console Libraries`' motion row fixes what may
// implement it: platform primitives (CSS transitions, `@starting-style`, View
// Transitions, the Web Animations API) with OUR OWN spring sampler emitting
// `linear()` easings, and no animation library on the render path.
//
// That row is a rejection with a reason, and the reason is what this file is: an
// animation library on the render path fights the virtualizer. The measured
// alternatives each lose on a different axis — one re-measures layout per render
// and costs tens of kilobytes in its layout shape, one runs its own frame loop
// and never reaches the Web Animations API at all, one attaches a per-child
// observer and a poll per element. What is actually needed from all of that is a
// function from spring constants to a string, and that function is below.
//
// WHY THIS LIVES IN `tokens/` AND CARRIES NO DOM TYPE. `tokens/` is a VOCABULARY
// family: the assets tier reads it from Node to check the generated sheet against
// the palette it came from, so a module here that names `Document` or `Window`
// puts types into a program that has neither. Every function below is therefore
// pure — it takes numbers and returns strings — and this module reaches no global,
// which is also why its own tests need no DOM.
//
// WHAT THIS MODULE PUBLISHES IS WHAT THE SHEET SPENDS, AND NOTHING ELSE. The scale
// and the spring both left `palette.ts`, which answers "what colour is this?" and
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
 * sampler that eases it left this module's own first line false.
 */
export const MOTION_DURATIONS_MS: Readonly<Record<string, number>> = {
  "motion-quick": 120,
  "motion-settle": 180,
  "motion-thread": 240,
};

/**
 * How many points a sampled easing is emitted with.
 *
 * `linear()` is a piecewise-linear approximation, so the count is the error
 * budget: too few and a settle visibly kinks, too many and every animated rule
 * carries a long string the style engine re-parses. Sixteen intervals put the
 * worst-case deviation from the true spring under half a percent of the travel
 * over the durations rule 5 admits, which is well below a pixel on the 2 px rise
 * that is the console's largest chrome displacement.
 */
const SPRING_SAMPLE_COUNT = 16;

/** Decimal places each sampled value is emitted with. */
const SPRING_SAMPLE_PRECISION = 4;

/**
 * A spring, in the terms a designer states one in.
 *
 * `damping` at or above the critical value is what makes a settle a settle: rule
 * 5 admits zero overshoot in chrome, and an under-damped spring overshoots by
 * construction. That property is asserted where it can be OBSERVED — on the
 * sampled easing, whose values never exceed 1 for these constants and do exceed
 * it for an under-damped negative control — rather than on a predicate over the
 * constants, which would only restate the arithmetic below it.
 */
export interface SpringDescriptor {
  /** Stiffness, in the usual mass-spring-damper sense. Higher arrives sooner. */
  readonly stiffness: number;
  /** Damping coefficient. At or above critical the spring never overshoots. */
  readonly damping: number;
  /** Mass. Higher is slower and heavier for the same stiffness. */
  readonly mass: number;
}

/**
 * The console's one chrome spring: critically damped, so it settles onto its
 * target rather than passing through it.
 *
 * Critical damping for these constants is `2 * sqrt(stiffness * mass)` = 40, and
 * the value is stated as that number rather than derived at module scope so the
 * descriptor stays a plain readable record — `motion.test.ts` samples it and holds
 * the emitted curve to the overshoot rule.
 */
export const CHROME_SETTLE_SPRING: SpringDescriptor = {
  stiffness: 400,
  damping: 40,
  mass: 1,
};

/**
 * Sample a spring into a CSS `linear()` easing.
 *
 * The emitted string is a value for `transition-timing-function` or
 * `animation-timing-function`, so the animation runs on the compositor under the
 * platform's own timing rather than under a frame loop of ours. That is the whole
 * point of the sampler: the spring is computed ONCE, at the moment a token is
 * defined, and never again while anything is on screen.
 *
 * The first and last samples are pinned to exactly 0 and 1. A settle approaches
 * its target asymptotically, so the raw final sample is a hair short, and an
 * easing that ends at 0.9997 leaves the animated property a hair short forever.
 */
export function sampleSpringEasing(
  spring: SpringDescriptor,
  sampleCount: number = SPRING_SAMPLE_COUNT,
): string {
  if (!Number.isInteger(sampleCount) || sampleCount < 2) {
    throw new RangeError(`A linear() easing needs at least two samples; received ${sampleCount}.`);
  }
  const samples: string[] = [];
  for (let index = 0; index <= sampleCount; index += 1) {
    if (index === 0) {
      samples.push("0");
      continue;
    }
    if (index === sampleCount) {
      samples.push("1");
      continue;
    }
    const progress = springProgressAt(spring, index / sampleCount);
    samples.push(Number(progress.toFixed(SPRING_SAMPLE_PRECISION)).toString());
  }
  return `linear(${samples.join(", ")})`;
}

/**
 * The spring's normalized displacement at a normalized time.
 *
 * Returns progress from 0 at rest to 1 at target — the shape an easing wants,
 * which is the complement of the classical displacement-from-target solution.
 * Both damping regimes are solved in closed form rather than integrated: an
 * integrator would need a step size, and a step size is a second accuracy knob
 * for a curve that has an exact answer.
 *
 * Private, and `sampleSpringEasing` is the whole public surface: the emitted
 * string is what any caller can spend, and a test that reached the closed form
 * directly would be checking the sampler against the very function it samples.
 */
function springProgressAt(spring: SpringDescriptor, normalizedTime: number): number {
  const angularFrequency = Math.sqrt(spring.stiffness / spring.mass);
  const dampingRatio = spring.damping / criticalDamping(spring);
  const scaledTime = angularFrequency * normalizedTime;

  if (dampingRatio < 1) {
    const dampedFrequency = Math.sqrt(1 - dampingRatio * dampingRatio);
    const envelope = Math.exp(-dampingRatio * scaledTime);
    const oscillation =
      Math.cos(dampedFrequency * scaledTime) +
      (dampingRatio / dampedFrequency) * Math.sin(dampedFrequency * scaledTime);
    return 1 - envelope * oscillation;
  }

  if (dampingRatio === 1) {
    return 1 - Math.exp(-scaledTime) * (1 + scaledTime);
  }

  // Over-damped: two real roots, no oscillation term at all.
  const excess = Math.sqrt(dampingRatio * dampingRatio - 1);
  const slowRoot = -dampingRatio + excess;
  const fastRoot = -dampingRatio - excess;
  const slowWeight = fastRoot / (fastRoot - slowRoot);
  const fastWeight = -slowRoot / (fastRoot - slowRoot);
  return (
    1 -
    (slowWeight * Math.exp(slowRoot * scaledTime) + fastWeight * Math.exp(fastRoot * scaledTime))
  );
}

/** The damping coefficient at which a spring stops overshooting. */
function criticalDamping(spring: SpringDescriptor): number {
  return 2 * Math.sqrt(spring.stiffness * spring.mass);
}
