// The spring sampler: the oracle behind `motion.ts`'s emitted settle easing. It is our own
// sampler emitting `linear()` easings, in place of an animation library on the render path. What
// ships is its output, `CHROME_SETTLE_EASING`, because the only call passed two module-scope
// constants and a pure function of constants is a constant.
//
// It is `.test-support` as a checked claim: nothing that ships imports it (the
// `test-support-has-no-shipping-reader` rule in `apps/desktop/.dependency-cruiser.mjs`), and its
// one reader is `motion.test.ts`, which holds the shipped constant to it and asserts every claim
// about the curve against this function.
//
// It carries no DOM type, since the generated-asset tier reads `styles/` modules from Node.

/**
 * How many points a sampled easing is emitted with. `linear()` is piecewise-linear, so the count
 * is the error budget: sixteen intervals keep the worst-case deviation from the true spring under
 * half a percent of the travel, well below a pixel on the 2 px rise.
 */
const SPRING_SAMPLE_COUNT = 16;

/** Decimal places each sampled value is emitted with. */
const SPRING_SAMPLE_PRECISION = 4;

/**
 * A spring, in the terms a designer states one in. A `damping` at or above the critical value is
 * what makes a settle, since the motion rule admits no overshoot in chrome; that is asserted on
 * the sampled easing, where it can be observed.
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
 * The console's one chrome spring: critically damped, so it settles onto its target. Critical
 * damping here is `2 * sqrt(stiffness * mass)` = 40, stated as a number to keep the descriptor a
 * plain record. It lives beside the sampler because it is the sampler's input.
 */
export const CHROME_SETTLE_SPRING: SpringDescriptor = {
  stiffness: 400,
  damping: 40,
  mass: 1,
};

/**
 * Sample a spring into a CSS `linear()` easing that runs on the compositor under the platform's
 * timing. The first and last samples are pinned to exactly 0 and 1, since a settle approaches its
 * target asymptotically; throws `RangeError` for a sample count that is not an integer of at
 * least two.
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

// The spring's normalized displacement at a normalized time, 0 at rest to 1 at target. Solved in
// closed form because an integrator would add a step-size knob to a curve with an exact answer.
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
