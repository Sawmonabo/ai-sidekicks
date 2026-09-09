// What one diff creation publishes, and the sentences its own refusals render as.
//
// TWO HALVES, BECAUSE THE FAMILY'S ACT VOCABULARY ALREADY HAS TWO. `store/act/act-reading.ts`
// separates the QUESTION an act depends on from the act itself, and a diff create has
// both: the subject has to be resolved to one of the wire's two attribution keys before
// any request can be built, and that resolution fails for reasons — a worktree this
// session does not hold, a root nothing ran in — that are not failures of the create. A
// single arm would have reported "the diff was refused" to somebody who has not pressed
// anything yet.
//
// THE SETTLED ARM CARRIES THE WHOLE MODEL rather than an id to look one up by: the pane
// renders this value directly, and a reading holding an id would make the surface ask a
// second question it already has the answer to.
//
// THE COPY LIVES HERE AND NOT IN THE COMPONENT, on this family's own rule: a sentence
// composed inside a render is a sentence no test can reach without mounting one, and
// each of these has to say what happened WITHOUT restating a daemon refusal in the
// console's own words.

import type { ActReading } from "../../../store/index.js";
import { DIFF_PATCH_CHARACTER_CAP } from "../../../core/index.js";
import type { ConsoleDiffModel } from "../diff-model.js";
import type { ComparedStates } from "../patch-parse.js";
import { comparedStatesNamed, type ResolvedDiffCreateSubject } from "./diff-create-subject.js";
import type { DiffPayloadReading } from "./diff-payload-reading.js";

/** Where the console's own refusals about a diff creation say they came from. */
export const DIFF_CREATE_REFUSAL_ORIGIN = "repos-diff-create";

/**
 * The codes this surface mints for itself.
 *
 * ONE ARRAY AND NO COUNT IN PROSE, on `growth-call.ts`'s rule: a number in a sentence is
 * not something a fourth code can fail against. Each names a fact the daemon did not
 * report — a subject this console could not resolve to an arm's key, a payload that came
 * back as something other than a patch, and a patch the parser refused.
 */
export const DIFF_CREATE_REFUSAL_CODES = [
  "subject-unresolved",
  "payload-not-a-patch",
  "patch-unparsable",
] as const;

/** One code this surface mints. Derived, so the vocabulary is declared exactly once. */
export type DiffCreateRefusalCode = (typeof DIFF_CREATE_REFUSAL_CODES)[number];

/**
 * The act's own settled arm: a change set, on screen.
 *
 * `created` RATHER THAN `settled`, which is `act-reading.ts`'s rule for the arm a caller
 * owns: what a person reads off a finished create is the verb of the thing they did, and
 * a shared word would have made every act in this family say the same one.
 */
export interface DiffCreatedArm {
  readonly status: "created";
  readonly diff: ConsoleDiffModel;
}

/** Both halves of one creation — the subject resolution, and the create itself. */
export type DiffCreationReading = ActReading<ResolvedDiffCreateSubject, DiffCreatedArm>;

/**
 * The sentence a served payload that is not a patch renders as.
 *
 * ONE PER ARM AND NONE OF THEM SAYS "FAILED", because none of them is a failure: the
 * daemon minted the artifact and answered the read. What differs is what a person can do
 * next, and that is what each sentence names — nothing, in the deferred case, because no
 * verb registered anywhere fetches a payload by its handle.
 */
export function payloadNotAPatchDetail(reading: DiffPayloadReading): string {
  switch (reading.status) {
    case "deferred":
      return "The diff was minted and its payload came back as a fetch handle rather than as bytes. No registered call fetches a payload by handle, so the change set cannot be read on this build.";
    case "opaque":
      return reading.reason === "undecodable"
        ? `The diff payload arrived ${reading.encoding}-encoded and would not decode, so nothing was parsed.`
        : `The diff payload arrived ${reading.encoding}-encoded and is not text, so it is not a patch this surface can render.`;
    case "over-cap":
      return `The diff payload is ${String(reading.characterCount)} characters, past the ${String(DIFF_PATCH_CHARACTER_CAP)} this surface parses. It is not rendered rather than rendered in part, because the files a cut would drop are the ones a reader would not know to look for.`;
    case "patch":
      // Unreachable by construction — the caller narrows the patch arm off before it
      // asks for this sentence — and stated rather than thrown, because a sentence is a
      // worse thing to crash a pane over than to render.
      return "The diff payload is a patch.";
  }
}

/**
 * What a patch this console could not read renders as.
 *
 * A CONSTANT, AND THE THROWN MESSAGE IS DELIBERATELY NOT IN IT. The parser refuses on
 * its own count check and `diff` refuses on its own grammar, and neither message is this
 * console's to relay: a rejection off a parse can carry the patch text that caused it,
 * which is repository content. `Spec-023 §Console Design (Meridian)` rule 9 is the rule,
 * and the artifact id below is the handle a person takes to the diagnostic band instead.
 */
export function patchUnparsableDetail(artifactManifestId: string): string {
  return `The diff was minted and its payload is text, and this console could not read that text as a unified patch. Nothing is rendered rather than part of a change set being rendered. The payload is the artifact ${artifactManifestId}.`;
}

/** What a worktree whose row names no run renders as, in the console's own words. */
export const WORKTREE_WITHOUT_RUN_DETAIL =
  "A diff over an execution root is attributed to the run that provisioned it, and this root's record names no run — a root prepared ahead of any run has none. Nothing here picks one for it.";

/** What a worktree the session's roots read does not contain renders as. */
export const WORKTREE_NOT_IN_SESSION_DETAIL =
  "This session's execution roots do not include the one this pane was opened over, so there is no record to read a run from.";

/** What pressing create before the subject resolved renders as. */
export const SUBJECT_NOT_RESOLVED_DETAIL =
  "The subject this diff would be attributed to has not been resolved yet, so no request was built. Nothing was sent.";

/**
 * Whether the create control may be pressed, and what is holding it when it may not.
 *
 * A PREDICATE AND NOT A RENDER, on `root-act-model.ts`'s seam: what holds a control is
 * a rule over the reading and the form, and a rule written inside a component is one no
 * test can reach without mounting it. The sentence travels with the verdict so the
 * blocked line under the control is the same fact the `disabled` attribute is.
 *
 * THE ORDER IS DELIBERATE. A create already in flight is reported ahead of an
 * unresolved attribution, because a person who has just pressed is asking about the
 * press; and the attribution is reported ahead of the empty fields, because naming two
 * refs would not make an unattributable subject sendable.
 */
export type DiffCreateStanding =
  | { readonly status: "sendable" }
  | { readonly status: "held"; readonly because: string };

/** One held verdict, so the four reasons share a shape. */
const HELD_SENDABLE: DiffCreateStanding = { status: "sendable" };

export function diffCreateStanding(
  reading: DiffCreationReading,
  comparedStates: ComparedStates,
): DiffCreateStanding {
  if (reading.act.status === "sending") {
    return { status: "held", because: "A diff is being minted." };
  }
  switch (reading.prerequisite.status) {
    case "not-read":
    case "reading":
      return { status: "held", because: "Resolving what this diff would be attributed to." };
    case "refused":
      return {
        status: "held",
        because:
          "This diff has nothing to be attributed to, so no request can be built. The refusal above says why.",
      };
    case "read":
      break;
  }
  return comparedStatesNamed(comparedStates)
    ? HELD_SENDABLE
    : {
        status: "held",
        because: "Name both compared states — a diff is taken between two of them.",
      };
}
