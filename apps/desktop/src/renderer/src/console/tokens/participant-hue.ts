// The participant hue system — `Spec-023 §Console Design (Meridian)` rule 2.
//
// Hue answers "who", everywhere: attribution edges, cast-bar rings, typing
// indicators, pane focus rings, diff-gutter attribution, handoff ticks. It never
// answers "how urgent" — that is the two-hue rule's job.
//
// The rule has four moving parts and this module is the only implementation of
// any of them:
//
//   1. **Join-log order.** Allocation walks participants in the order the
//      session log admitted them, so the same log produces the same wheel on
//      every replay, on every machine, in every window. Allocation keyed on
//      anything the renderer observes (arrival over the wire, render order) would
//      hand the same person a different color in a second window.
//   2. **Hash-mod-twelve preferred step.** A participant's first choice is
//      `hash(participantId) mod 12`, so a person tends to keep a color across
//      sessions without any stored assignment.
//   3. **Clockwise next-free resolution.** A taken preferred step walks +1 until
//      a free step is found. `Spec-023 §Console Design (Meridian)` rule 2 puts it
//      as "two participants adjacent on the wheel in one session are separated by
//      the next free step": the separation is what matters, and walking one
//      direction makes it deterministic.
//   4. **Wrap, distinguished by ring and glyph, not by hue.** Past twelve
//      participants some step must repeat. Inventing a thirteenth hue would break
//      the fixed-lightness guarantee the contrast floors rest on, and dimming one
//      would make identity read as state — so the wheel wraps and the LAP is
//      carried on the result for the renderer to express as a ring treatment and
//      a glyph. Two participants can then share a hue and still never be
//      confused, because the ring differs.
//
// **Departures free nothing.** A step allocated to a participant stays theirs for
// the session's lifetime. Freeing it would let a later joiner inherit a departed
// participant's color, which rewrites the meaning of every row that participant
// already wrote — the timeline is a log, and a log's attribution does not change
// because someone left the room.

import type { OklchColor } from "./color.js";
import { PARTICIPANT_HUE_STEPS } from "./palette.js";
import { participantHue, participantHueTokenName } from "./tokens.js";

/**
 * The ring treatments, indexed by wrap lap. A session with more than
 * `PARTICIPANT_HUE_STEPS * RING_TREATMENTS.length` participants exhausts the
 * distinct treatments and reuses the last one — which is a real limit, stated
 * here rather than hidden: at 49 participants in one session the cast bar has
 * long since folded to "+N" and identity is read from the roster, not the ring.
 *
 * The tuple is the declaration; the treatment union is derived from it. Written
 * separately, the lap index would run off the end of one while the other still
 * typechecked.
 */
export const RING_TREATMENTS = ["solid", "dashed", "double", "dotted"] as const;

/** How a wrapped step is told apart from the step it repeats. */
export type ParticipantRingTreatment = (typeof RING_TREATMENTS)[number];

/** One participant's place on the wheel. */
export interface ParticipantHueAssignment {
  /** The participant this assignment belongs to. */
  readonly participantId: string;
  /** Wheel step, 0 to `PARTICIPANT_HUE_STEPS - 1`. */
  readonly step: number;
  /** How many complete laps of the wheel preceded this assignment. */
  readonly wrapLap: number;
  /** The ring treatment that distinguishes this lap from the ones before it. */
  readonly ringTreatment: ParticipantRingTreatment;
  /** The resolved color of the step. */
  readonly color: OklchColor;
  /** The CSS custom-property name carrying that color. */
  readonly tokenName: string;
  /** True when this assignment shares its step with an earlier participant. */
  readonly sharesStepWithEarlierParticipant: boolean;
}

/**
 * FNV-1a over the id's UTF-16 code units, folded to 32 bits.
 *
 * Chosen over a cryptographic digest because the property needed is even spread
 * over twelve buckets, not preimage resistance, and because this runs
 * synchronously on the render path where `crypto.subtle` is a promise. Chosen
 * over `String.prototype.charCodeAt` summing because a sum collides on
 * anagrams, and participant ids in this corpus are UUIDs whose characters are
 * drawn from a sixteen-symbol alphabet.
 */
export function hashParticipantId(participantId: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < participantId.length; index += 1) {
    hash ^= participantId.charCodeAt(index);
    // The FNV prime, 16777619, by shift-and-add so the product stays in the
    // 32-bit range Math would otherwise lose precision on.
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    hash >>>= 0;
  }
  return hash >>> 0;
}

/** The step a participant would take if the wheel were empty. */
export function preferredHueStep(participantId: string): number {
  return hashParticipantId(participantId) % PARTICIPANT_HUE_STEPS;
}

/**
 * Allocates wheel steps for one session. Construct one per session store and
 * feed it the join log in order; it is deliberately NOT a module-level singleton,
 * because two sessions each start their own wheel.
 */
export class ParticipantHueAllocator {
  readonly #assignmentsByParticipantId = new Map<string, ParticipantHueAssignment>();
  readonly #occupantCountByStep: number[] = new Array<number>(PARTICIPANT_HUE_STEPS).fill(0);

  /**
   * Admit a participant in join-log order and return its assignment. Idempotent:
   * re-admitting a participant already on the wheel returns the same assignment
   * and allocates nothing, which is what makes a re-join keep its color.
   *
   * AN AGENT'S ID IS ADMITTED EXACTLY AS A PARTICIPANT'S IS, and that is deliberate
   * rather than incidental. The store feeds this wheel from each event's `actorId`,
   * which the wire registers as a participant id, an agent id, or nobody, with no
   * discriminator between the first two — so the wheel is keyed on WHOEVER an event is
   * attributed to, and both kinds get a colour by the same hash, on the same wheel,
   * with the same re-admission rule. It has to be one wheel: two people and an agent
   * are three speakers on one timeline, and colouring agents from a second wheel would
   * let one collide with a participant it sits next to. The parameter keeps the
   * `participantId` spelling every caller and helper here already uses; what it names
   * is an identity on the wheel, not a claim about which kind it is.
   */
  public admit(participantId: string): ParticipantHueAssignment {
    const existing = this.#assignmentsByParticipantId.get(participantId);
    if (existing !== undefined) {
      return existing;
    }

    const preferredStep = preferredHueStep(participantId);
    const step = this.#nextFreeStepFrom(preferredStep);
    const occupantCount = this.#occupantCountByStep[step] ?? 0;
    const wrapLap = occupantCount;
    const ringTreatment = RING_TREATMENTS[Math.min(wrapLap, RING_TREATMENTS.length - 1)] ?? "solid";

    const assignment: ParticipantHueAssignment = {
      participantId,
      step,
      wrapLap,
      ringTreatment,
      color: participantHue(step),
      tokenName: participantHueTokenName(step),
      sharesStepWithEarlierParticipant: occupantCount > 0,
    };

    this.#occupantCountByStep[step] = occupantCount + 1;
    this.#assignmentsByParticipantId.set(participantId, assignment);
    return assignment;
  }

  /**
   * The assignment a participant already holds, or `undefined` when the wheel has
   * never seen it. Reading is side-effect free — a renderer that asks about an
   * unknown participant must render the unrecognized shape, not silently mint an
   * identity, so this does NOT allocate.
   */
  public assignmentFor(participantId: string): ParticipantHueAssignment | undefined {
    return this.#assignmentsByParticipantId.get(participantId);
  }

  /** Every assignment, in join-log order. */
  public assignments(): readonly ParticipantHueAssignment[] {
    return [...this.#assignmentsByParticipantId.values()];
  }

  /** How many participants the wheel has admitted. */
  public get admittedCount(): number {
    return this.#assignmentsByParticipantId.size;
  }

  /**
   * Walk clockwise from the preferred step to the first step with the fewest
   * occupants. Below twelve participants "fewest" is zero and this is exactly the
   * next-free rule; at and above twelve it is what keeps the wrap even instead of
   * piling every overflow onto one step.
   */
  #nextFreeStepFrom(preferredStep: number): number {
    let bestStep = preferredStep;
    let bestOccupantCount = this.#occupantCountByStep[preferredStep] ?? 0;
    if (bestOccupantCount === 0) {
      return preferredStep;
    }
    for (let offset = 1; offset < PARTICIPANT_HUE_STEPS; offset += 1) {
      const candidateStep = (preferredStep + offset) % PARTICIPANT_HUE_STEPS;
      const candidateOccupantCount = this.#occupantCountByStep[candidateStep] ?? 0;
      if (candidateOccupantCount === 0) {
        return candidateStep;
      }
      if (candidateOccupantCount < bestOccupantCount) {
        bestStep = candidateStep;
        bestOccupantCount = candidateOccupantCount;
      }
    }
    return bestStep;
  }
}
