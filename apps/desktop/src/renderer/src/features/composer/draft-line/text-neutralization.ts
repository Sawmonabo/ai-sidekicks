// Reads the text-neutralization tripwire off a failed run. A send whose first word is
// command-shaped for the bound provider is neutralized in transport only; when the guard trips
// the driver fails the run and `providerFailureDetail` carries `<code> origin=<arm>`.
//
// That field also carries free-form resume-failure prose, and its contract says to read the
// cause as the substring before the first space. This module is that read, done once. The code
// takes its type from the contract, so a rename breaks the build instead of silently not matching.

import type { DriverInterventionResult } from "@ai-sidekicks/contracts/provider/driver/intervention";

/** The registered refusal code, taken from the contract rather than retyped. */
export type TextNeutralizationRefusalCode = NonNullable<DriverInterventionResult["refusalCode"]>;

const TEXT_NEUTRALIZATION_CODE: TextNeutralizationRefusalCode = "driver.text_neutralization_failed";

const ORIGIN_KEY = "origin=";

/** The origin arms; `unknown` is a driver saying it could not attribute the text. */
export const TEXT_NEUTRALIZATION_ORIGINS = ["human_text", "system_narration", "unknown"] as const;

/** One origin arm. */
export type TextNeutralizationOrigin = (typeof TEXT_NEUTRALIZATION_ORIGINS)[number];

/** What a tripped guard says, once read. */
export interface TextNeutralizationReading {
  readonly code: TextNeutralizationRefusalCode;
  /**
   * The arm the detail named, or `undefined` when it named none this reading knows. Not
   * defaulted to `"unknown"`: that arm is a driver statement, an unread arm is the console's gap.
   */
  readonly origin: TextNeutralizationOrigin | undefined;
  readonly wireDetail: string;
}

/**
 * Read a failed run's `providerFailureDetail` as a neutralization trip, or `undefined` for
 * any other detail, so a resume failure never renders as one.
 */
export function readTextNeutralization(
  providerFailureDetail: string | undefined,
): TextNeutralizationReading | undefined {
  if (providerFailureDetail === undefined) {
    return undefined;
  }
  // The wire's rule: the cause is the substring before the first space.
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

function readOrigin(remainder: string): TextNeutralizationOrigin | undefined {
  const marker = remainder.indexOf(ORIGIN_KEY);
  if (marker === -1) {
    return undefined;
  }
  const named = remainder.slice(marker + ORIGIN_KEY.length).trim();
  return TEXT_NEUTRALIZATION_ORIGINS.find((origin) => origin === named);
}
