// The spring sampler: the oracle behind `motion.ts`'s emitted settle easing.
//
// `Spec-023 §Console Libraries`' motion row asks for OUR OWN spring sampler emitting
// `linear()` easings rather than an animation library on the render path, and this is
// it. What ships is the string it answers — `CHROME_SETTLE_EASING` in `motion.ts` —
// because the only call the console ever made passed two module-scope constants, so
// the closed-form solution, its three damping branches, and the sample loop were
// riding the initial import graph to recompute the same 106 characters at every
// mount. A pure function of constants is a constant, and the constant is what the
// sheet spends.
//
// SO THIS MODULE IS `.test-support`, WHICH IS A CLAIM RATHER THAN A LABEL. Nothing
// that ships imports it — `apps/desktop/.dependency-cruiser.mjs`'s
// `test-support-has-no-shipping-reader` is what makes that a checked property rather
// than a sentence — and its one reader is `motion.test.ts`, which holds the shipped
// constant to it. That test is this module's suite as well as the constant's: the two
// are one subject, because a sampler nobody calls and a string nobody derived are
// each worthless alone. Every claim rule 5 makes about the curve — zero overshoot,
// the under-damped negative control that proves the assertion can fail, the
// over-damped branch, monotonicity, the refusal on a sample count that cannot
// describe a curve — is still asserted there, against this function.
//
// IT CARRIES NO DOM TYPE, for the reason the whole `tokens/` family carries none: the
// generated-asset tier reads this family from node, and a module here that named
// `Document` or `Window` would put those types into a program that has neither. Every
// function below takes numbers and returns strings.

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
 * descriptor stays a plain readable record. It lives beside the sampler rather than
 * beside the emitted string because it is the sampler's INPUT: `motion.ts` ships
 * what these constants produce, and the only reader that still needs the constants
 * themselves is the test that re-derives the string from them.
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
 * point of the sampler: the spring is computed ONCE — at build time now, and by the
 * test that keeps `CHROME_SETTLE_EASING` honest — and never while anything is on
 * screen.
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
