// Reading the text-neutralization tripwire off a failed run.
//
// `Spec-005 §Required Behavior` (provider-bound text neutrality): a send whose first
// word is command-shaped for the bound provider is neutralized at the driver
// boundary IN TRANSPORT ONLY — the participant's text is never changed in the
// ledger. When the guard trips, the driver fails the run rather than recording the
// provider's zero-turn success, and the terminal carries the reason.
//
// THE FORM IS FIXED AND THE CONSUMER RULE IS STATED ON THE WIRE ITSELF.
// `RunStateChangeEvent.providerFailureDetail` has two producers — free-form prose
// from the resume-failure producer, and this one fixed
// `<registered code> origin=<arm>` form — and its own contract says a consumer
// "reads the cause as the substring before the first space and MUST NOT assume the
// whole value is prose". This module is that read, done once. A surface matching on
// the string itself would be a second parser for a shape one comment governs, and
// the two would drift the first time an arm was added.
//
// THE CODE IS NOT SPELLED HERE. `driver.text_neutralization_failed` is a registered
// literal on `DriverInterventionResult.refusalCode`, so the constant below is that
// literal's own type rather than a copy of its text — a rename in `packages/contracts`
// becomes a compile error here instead of a match that silently stops firing.

import type { DriverInterventionResult } from "@ai-sidekicks/contracts";

/**
 * The registered refusal code, taken from the contract rather than retyped.
 *
 * `NonNullable` because the member is optional on the wire: it is present exactly
 * when the guard tripped, which is the one case this module reads.
 */
export type TextNeutralizationRefusalCode = NonNullable<DriverInterventionResult["refusalCode"]>;

/** The one code this reading recognises, bound to the contract's own literal type. */
const TEXT_NEUTRALIZATION_CODE: TextNeutralizationRefusalCode = "driver.text_neutralization_failed";

/** The key the origin arm rides under inside the fixed form. */
const ORIGIN_KEY = "origin=";

/**
 * The arms the origin can name.
 *
 * Closed at three because the form itself is closed at three, and `unknown` is one
 * of them rather than the absence of one — a driver that could not attribute the
 * text says so, and the surface renders that as a different fact from a driver that
 * attributed it to the participant.
 */
export const TEXT_NEUTRALIZATION_ORIGINS = [
  "participant_text",
  "system_narration",
  "unknown",
] as const;

/** One origin arm. Derived from the enumeration, never restated. */
export type TextNeutralizationOrigin = (typeof TEXT_NEUTRALIZATION_ORIGINS)[number];

/** What a tripped guard says, once read. */
export interface TextNeutralizationReading {
  readonly code: TextNeutralizationRefusalCode;
  /**
   * The arm the detail named, or `undefined` when it named none this reading knows.
   *
   * `undefined` rather than defaulting to `"unknown"`: the wire's own `unknown` arm
   * is a driver SAYING it could not attribute the text, and a detail carrying no
   * recognised arm at all is the console failing to read it. Collapsing the two
   * would report a driver statement the driver never made.
   */
  readonly origin: TextNeutralizationOrigin | undefined;
  /** The detail exactly as the daemon sent it, for the mono figure beside the copy. */
  readonly wireDetail: string;
}

/**
 * Read a failed run's `providerFailureDetail` as a neutralization trip, or not.
 *
 * `undefined` for every other detail, prose included — which is the point: this
 * reading claims the trip only when the fixed form is actually there, so a resume
 * failure never renders as a neutralization one.
 */
export function readTextNeutralization(
  providerFailureDetail: string | undefined,
): TextNeutralizationReading | undefined {
  if (providerFailureDetail === undefined) {
    return undefined;
  }
  // The wire's own rule: the cause is the substring before the first space.
  const firstSpace = providerFailureDetail.indexOf(" ");
  const cause =
    firstSpace === -1 ? providerFailureDetail : providerFailureDetail.slice(0, firstSpace);
  if (cause !== TEXT_NEUTRALIZATION_CODE) {
    return undefined;
  }
  return {
    code: TEXT_NEUTRALIZATION_CODE,
    origin: readOrigin(providerFailureDetail.slice(firstSpace + 1)),
    wireDetail: providerFailureDetail,
  };
}

/** The arm named after the cause, or `undefined` when none of the three is named. */
function readOrigin(remainder: string): TextNeutralizationOrigin | undefined {
  const marker = remainder.indexOf(ORIGIN_KEY);
  if (marker === -1) {
    return undefined;
  }
  const named = remainder.slice(marker + ORIGIN_KEY.length).trim();
  return TEXT_NEUTRALIZATION_ORIGINS.find((origin) => origin === named);
}
