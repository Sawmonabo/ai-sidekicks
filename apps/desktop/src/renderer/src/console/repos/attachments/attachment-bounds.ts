// The four bounds an attachment can hit, and what a carrier stands at against two of
// them.
//
// THE SEAM, IN ONE SENTENCE: this module answers what the DEPLOYMENT admits and where
// a carrier stands inside that, for every surface that has to say so before a file is
// chosen. It renders nothing, calls nothing, and holds no copy about a refusal — the
// refusal vocabulary is `artifacts/artifact-refusal-copy.ts`, one directory over, and
// the daemon's own allow-list is `attachment-policy.ts` below it.
//
// WHY THE READING LIVES HERE AND NOT ON THE PANE THAT FIRST READ IT. The shape and
// the shipped default were declared in `repos/artifact-pane/artifact-pane-reading.ts`,
// which is one surface's reading module, while the values inside it are this family's:
// the allow-list is `attachment-policy.ts`'s and the byte bound is `core/constants.ts`'s
// `ATTACHMENT_BYTE_CAP_DEFAULT`. Two surfaces now say what will be accepted — the
// artifact pane's disclosure and the attach affordance itself — so the shape moved DOWN
// to the module both of them already depend on rather than sideways into a second copy.
// The pane's reader still owns WHO ASKED and what a served answer means; this owns what
// the answer IS.
//
// AND THE AFFORDANCE DOES NOT ASK. `bridge/growth-port/growth-port.ts` refuses
// `artifactAllowlistRead` by name on every build the console can be run on today, so a
// second reader here would be a second scheduled reading, a second census entry, and a
// second refusal on screen — for a value that would come back as the shipped default in
// every reachable state. The affordance therefore renders `SHIPPED_DEFAULT_ALLOWLIST`
// and says which of the two lists that is, which is exactly the arm `Spec-014 §Bounds
// (normative defaults; operator-tunable)` names for a deployment whose effective list
// cannot be read. When the read is registered, the affordance takes the pane's reading
// through this same shape and nothing about the disclosure changes.

import {
  ATTACHMENTS_PER_CARRIER_CAP_DEFAULT,
  ATTACHMENT_BYTE_CAP_DEFAULT,
} from "../../core/index.js";
import type { ConsoleRefusal } from "../../core/index.js";
import { ATTACHMENT_ALLOWLIST_DEFAULT } from "./attachment-policy.js";

/**
 * The effective allow-list and byte bound, with where they came from.
 *
 * `source` is rendered rather than inferred. An operator override REPLACES the default
 * wholesale — `Spec-014 §Bounds (normative defaults; operator-tunable)` — so a hint that
 * could not say which of the two it is showing would be a hint a participant cannot
 * trust against a deployment they cannot see.
 */
export interface AttachmentAllowlistReading {
  readonly source: "effective" | "shipped-default";
  readonly mediaTypes: readonly string[];
  readonly maximumByteLength: number;
  /** Why the effective read did not answer, on the `shipped-default` arm. */
  readonly refusal: ConsoleRefusal | undefined;
}

/** The bounds the console ships with, when the deployment's own could not be read. */
export const SHIPPED_DEFAULT_ALLOWLIST: AttachmentAllowlistReading = {
  source: "shipped-default",
  mediaTypes: ATTACHMENT_ALLOWLIST_DEFAULT,
  maximumByteLength: ATTACHMENT_BYTE_CAP_DEFAULT,
  refusal: undefined,
};

/**
 * How full a carrier is against the count bound, as a figure and never as a gate.
 *
 * THE COUNT IS RENDERED AND THE DAEMON DECIDES. `attachment-ingest-machine.ts` states
 * the same rule from the other side: `Spec-014` refuses the whole carrier at acceptance
 * with `artifact.too_many_attachments`, so a console that stopped the eleventh attach
 * would be deriving eligibility the daemon owns and would be wrong the moment an
 * operator raises the bound. Nothing here answers "may I", and no surface reading this
 * withdraws the picker.
 */
export interface AttachmentCarrierFill {
  readonly attached: number;
  /** The shipped default count bound. Operator-tunable, so it is labelled as a default. */
  readonly allowance: number;
}

/** Where this carrier stands against the count bound. Total over any count. */
export function attachmentCarrierFill(attachedCount: number): AttachmentCarrierFill {
  return { attached: attachedCount, allowance: ATTACHMENTS_PER_CARRIER_CAP_DEFAULT };
}

/**
 * Whether one attachment's own declared length is past the per-attachment bound.
 *
 * DECLARED, WHICH IS THE ONLY LENGTH THE CONSOLE HAS BEFORE THE DAEMON DERIVES ONE.
 * `Spec-014 §Required Behavior` makes a caller's `sizeBytes` advisory, and this reads
 * the payload's own `Blob` size rather than a caller's claim — so the answer is a
 * warning ahead of `artifact.too_large` rather than a verdict standing in for it. The
 * upload is still attempted: the enforcement points are the daemon's three and the
 * console does not add a fourth.
 */
export function exceedsAttachmentByteAllowance(
  byteLength: number,
  maximumByteLength: number,
): boolean {
  return byteLength > maximumByteLength;
}
