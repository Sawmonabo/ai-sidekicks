// The agent hue wheel: which of the twelve steps each agent is drawn in. Hue answers "who"
// (leading edges, diff-gutter marks) and never "how urgent".
//
// An agent takes the next unused step in the order the session log admitted it, so the same log
// gives the same wheel on every replay. Past twelve agents the allocator takes the step with the
// fewest occupants, walking clockwise from the first, and the assignment says it shares its step.
// Departures free nothing: reusing a step would rewrite the meaning of every row its first agent
// already wrote.

import type { OklchColor } from "./color.js";
import { HUE_WHEEL_STEPS } from "./palette.js";
import { readHueWheelColor, formatHueWheelTokenName } from "./tokens.js";

/** One agent's place on the wheel. */
export interface AgentHueAssignment {
  /** The identity this assignment belongs to. */
  readonly agentId: string;
  /** Wheel step, 0 to `HUE_WHEEL_STEPS - 1`. */
  readonly step: number;
  /** The resolved color of the step. */
  readonly color: OklchColor;
  /** The CSS custom-property name carrying that color. */
  readonly tokenName: string;
  /** True when this assignment shares its step with an earlier one. */
  readonly sharesStepWithEarlierAgent: boolean;
}

/**
 * Allocates wheel steps for one session. Construct one per session store and feed it the log in
 * order. Not a module-level singleton, because each session starts its own wheel.
 */
export class AgentHueAllocator {
  readonly #assignmentsByAgentId = new Map<string, AgentHueAssignment>();
  readonly #occupantCountByStep: number[] = new Array<number>(HUE_WHEEL_STEPS).fill(0);

  /**
   * Admit an identity in log order and return its assignment. Idempotent, so a re-join keeps its
   * color. The store keys the wheel on each event's `actorId`.
   */
  public admit(agentId: string): AgentHueAssignment {
    const existing = this.#assignmentsByAgentId.get(agentId);
    if (existing !== undefined) {
      return existing;
    }

    const step = this.#leastOccupiedStep();
    const occupantCount = this.#occupantCountByStep[step] ?? 0;

    const assignment: AgentHueAssignment = {
      agentId,
      step,
      color: readHueWheelColor(step),
      tokenName: formatHueWheelTokenName(step),
      sharesStepWithEarlierAgent: occupantCount > 0,
    };

    this.#occupantCountByStep[step] = occupantCount + 1;
    this.#assignmentsByAgentId.set(agentId, assignment);
    return assignment;
  }

  /**
   * The assignment an identity already holds, or `undefined` when the wheel has never seen it.
   * Never allocates: a renderer asking about an unknown identity must show the unrecognized
   * shape, not mint one.
   */
  public assignmentFor(agentId: string): AgentHueAssignment | undefined {
    return this.#assignmentsByAgentId.get(agentId);
  }

  /**
   * The first step, walking clockwise from step 0, with the fewest occupants. Below twelve agents
   * that is the next unused step; past twelve it keeps the wrap even.
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
