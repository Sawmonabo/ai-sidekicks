// The agent hue wheel: which of the twelve steps each agent is drawn in.
//
// Hue answers "who", everywhere: leading edges, diff-gutter marks. It
// never answers "how urgent"; that is the two-hue rule's job.
//
// AN AGENT TAKES THE NEXT UNUSED STEP, in the order the session log admitted it, so the
// same log produces the same wheel on every replay, on every machine and in every
// window. Past twelve agents some step must repeat: the allocator then takes the step
// with the fewest occupants, walking clockwise from the first, so the wrap stays even,
// and the assignment says it shares its step.
//
// DEPARTURES FREE NOTHING. A step allocated to an agent stays its own for the session's
// lifetime. Freeing it would let a later agent inherit a departed one's color, which
// rewrites the meaning of every row that agent already wrote.

import type { OklchColor } from "./color.js";
import { HUE_WHEEL_STEPS } from "./palette.js";
import { readHueWheelColor, formatHueWheelTokenName } from "./tokens.js";

/** One agent's place on the wheel. */
export interface AgentHueAssignment {
  /** The identity this assignment belongs to. */
  readonly userId: string;
  /** Wheel step, 0 to `HUE_WHEEL_STEPS - 1`. */
  readonly step: number;
  /** The resolved color of the step. */
  readonly color: OklchColor;
  /** The CSS custom-property name carrying that color. */
  readonly tokenName: string;
  /** True when this assignment shares its step with an earlier one. */
  readonly sharesStepWithEarlierUser: boolean;
}

/**
 * Allocates wheel steps for one session. Construct one per session store and feed it
 * the log in order; it is deliberately NOT a module-level singleton, because two
 * sessions each start their own wheel.
 */
export class AgentHueAllocator {
  readonly #assignmentsByUserId = new Map<string, AgentHueAssignment>();
  readonly #occupantCountByStep: number[] = new Array<number>(HUE_WHEEL_STEPS).fill(0);

  /**
   * Admit an identity in log order and return its assignment. Idempotent:
   * re-admitting one already on the wheel returns the same assignment and allocates
   * nothing, which is what makes a re-join keep its color.
   *
   * The store feeds this wheel from each event's `actorId`, which the wire registers as
   * a user id, an agent id, or nobody, with no discriminator between the first two, so
   * the wheel is keyed on whoever an event is attributed to.
   */
  public admit(userId: string): AgentHueAssignment {
    const existing = this.#assignmentsByUserId.get(userId);
    if (existing !== undefined) {
      return existing;
    }

    const step = this.#leastOccupiedStep();
    const occupantCount = this.#occupantCountByStep[step] ?? 0;

    const assignment: AgentHueAssignment = {
      userId,
      step,
      color: readHueWheelColor(step),
      tokenName: formatHueWheelTokenName(step),
      sharesStepWithEarlierUser: occupantCount > 0,
    };

    this.#occupantCountByStep[step] = occupantCount + 1;
    this.#assignmentsByUserId.set(userId, assignment);
    return assignment;
  }

  /**
   * The assignment an identity already holds, or `undefined` when the wheel has never
   * seen it. Reading is side-effect free: a renderer that asks about an unknown identity
   * must render the unrecognized shape, not silently mint one, so this does NOT
   * allocate.
   */
  public assignmentFor(userId: string): AgentHueAssignment | undefined {
    return this.#assignmentsByUserId.get(userId);
  }

  /** Every assignment, in log order. */
  public assignments(): readonly AgentHueAssignment[] {
    return [...this.#assignmentsByUserId.values()];
  }

  /** How many identities the wheel has admitted. */
  public get admittedCount(): number {
    return this.#assignmentsByUserId.size;
  }

  /**
   * The first step, walking clockwise from step 0, with the fewest occupants. Below
   * twelve agents "fewest" is zero and this is the next unused step; at and above twelve
   * it keeps the wrap even instead of piling every overflow onto one step.
   */
  #leastOccupiedStep(): number {
    let bestStep = 0;
    let bestOccupantCount = this.#occupantCountByStep[0] ?? 0;
    for (let step = 1; step < HUE_WHEEL_STEPS && bestOccupantCount > 0; step += 1) {
      const occupantCount = this.#occupantCountByStep[step] ?? 0;
      if (occupantCount < bestOccupantCount) {
        bestStep = step;
        bestOccupantCount = occupantCount;
      }
    }
    return bestStep;
  }
}
