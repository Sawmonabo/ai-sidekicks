// Where one form stands with the thing that checks it, and which input mode that puts it in.
//
// WHY IT IS ITS OWN MODULE. `use-schema-form.ts` beside it owns the form's STATE — a draft
// tree, a raw document, one composed answer, one derived report. What is here is a
// different subject that happens to be read on every one of its renders: the four positions
// a form can be in with respect to the schema compiler, and the single function that turns
// one of them into the arm a person is answering in. The hook grew past this package's file
// ceiling holding both, and this is the seam it grew along — every declaration below is
// about the compiler and none of them is about a draft.
//
// A SCHEMA NOTHING COULD CHECK IS ANSWERED AS JSON, WHATEVER THE MAPPER DREW. A drawn
// control is a promise that the form will refuse a wrong value in it, and a schema the
// validator could not compile from cannot keep that promise — so the arm is decided in one
// place that holds BOTH readings, the mapper's plan and the compiler's verdict, rather than
// at the component: deciding it there would show the editor while the composed answer still
// read controls nobody could see.
//
// THE COMPILER ARRIVES, WHICH IS WHY THE VALIDATOR IS STATE AND WHY THERE IS AN ARM FOR
// BEFORE IT DOES. `compileSchemaValidator` reaches the console through a loader — the
// bridge door is on the initial import graph and the schema library behind that compiler
// is not something every launch may be charged for — so between a form's first render and
// the chunk landing there is a window in which the form exists and nothing can check what
// is typed into it. That window is a THIRD arm on this state and never a widening of the
// door's two-armed `SchemaValidator`: a surface reading `compiling` is being told the
// verdict has not been reached, which is a different fact from a schema that could not be
// compiled and from one that came back clean. While it holds, a form has NO report — not a
// clean one — and `SchemaFormAnswer` offers no act, because a verdict describes the bytes
// a submission carries and there is no verdict yet.
//
// AND THE ARRIVAL CAN FAIL, WHICH IS THE FOURTH ARM AND NOT A REUSE OF THE THIRD OR THE
// SECOND. A chunk fetch rejects on a damaged or half-updated install, and the window that
// opened for it does not close on its own: without an arm for it the controls stay drawn,
// the act stays shut, `aria-busy` stays true, and nothing on the screen says why — the
// worst state this form can reach, because it is indistinguishable from one still loading
// and never ends. `checker-unavailable` closes it. It is not `compiling`, which promises an
// answer that is not coming, and it is deliberately not `uncompilable`, whose stated reason
// is that the SCHEMA could not be compiled: that reason would be false, nothing having read
// the schema, and would send a person to correct a definition that is fine. What the arm
// does is what `uncompilable` does — open the raw editor and arm the act — because the
// honest position is the same one: this window will not check the answer, and the run
// itself still decides whether the answer is admissible.
//
// THE TWO SENTENCES A RAW ARM CARRIES ARE BOTH HERE, and they say different things on
// purpose. The FALLBACK is why the controls are absent, and it is read above the editor;
// the VALIDATOR's own detail is what will not be checked, and it is read beneath the
// document. Held together in one module because a reader deciding whether they overlap has
// to see both, and held once each because a literal composed per render would hand the
// surface a new plan on every keystroke.

import type { SchemaFallback, SchemaFormPlan } from "../plan/schema-fields.js";
import type { SchemaValidator } from "../../../bridge/index.js";

/**
 * What a form settled on for one schema: the door's own verdict, or the fact that the
 * thing that would have produced one never reached this window.
 *
 * Held apart from {@link SchemaValidatorState} because it is what a compile ROUND ends
 * with: `compiling` is the absence of a settlement rather than one of them, so a state
 * field typed over the whole union could hold a value the round never produces.
 */
export type SettledSchemaValidator =
  | SchemaValidator
  | {
      readonly status: "checker-unavailable";
      /** One sentence for the person looking at the form. See the header for its job. */
      readonly detail: string;
    };

/**
 * Where a form is with the compiler it needs: still fetching it, or how that ended.
 *
 * The door's two arms plus the two they cannot express. `SchemaValidator` answers what
 * compiling a schema CAME BACK WITH, and both of its arms are answers — so a third arm
 * added there would have made every reader of a compiled validator re-check whether an
 * answer had arrived at all, and a fourth would have made the door speak about a fetch it
 * does not perform. Here they are one union in one module, above the two consumers that
 * branch on it ({@link armFor} and the raw editor), and the door's shape is untouched.
 */
export type SchemaValidatorState = { readonly status: "compiling" } | SettledSchemaValidator;

/**
 * The one key a form's compile round is claimed under.
 *
 * One key and not one per schema: the rule is that a form has at most one compile in
 * flight, so a schema that supersedes another has to take the SAME key to abandon it.
 */
export const VALIDATOR_COMPILE_KEY = "schema-validator-compile";

/**
 * What the validator reads as before an answer exists. Held once, so a render that has
 * not compiled yet hands the surface the same value as the one before it.
 */
export const COMPILING_VALIDATOR: SchemaValidatorState = { status: "compiling" };

/**
 * The arm a form takes when the compiler's chunk did not arrive, sentence and all.
 *
 * Held once for {@link COMPILING_VALIDATOR}'s reason.
 *
 * The sentence says the CONSEQUENCE rather than repeating the failure the fallback below
 * already states, and it says what is still true: the answer can be sent, and what is
 * admissible was never a form's reading anyway — it is the run's.
 */
export const CHECKER_UNAVAILABLE: SettledSchemaValidator = {
  status: "checker-unavailable",
  detail:
    "Nothing typed here is checked against this phase's schema. The answer can still be sent, and the run itself decides whether it is admissible.",
};

/**
 * What a settled compile round installs, and the schema identity it is about.
 *
 * The two travel together because the answer is only about that schema: held apart, a
 * settlement for the schema a form has just left would read as that form's verdict for
 * exactly as long as the next compile takes. That holds for a round that ended in a
 * failed FETCH as much as for one that ended in a verdict, which is why the member is
 * typed over both.
 */
export interface CompiledForSchema {
  readonly inputSchema: unknown;
  readonly validator: SettledSchemaValidator;
}

/**
 * Why a schema whose members are all drawable is answered as JSON anyway.
 *
 * One sentence, and deliberately not the reader's: the raw editor already renders the
 * compiler's own detail beneath the document, so a reason repeating it would say one
 * thing twice. This one says what that sentence does not — which arm this is and why the
 * controls are absent rather than drawn and unchecked.
 */
const UNCHECKABLE_SCHEMA_FALLBACK: SchemaFallback = {
  cause: "schema-uncheckable",
  memberPath: [],
  detail:
    "This phase's schema could not be compiled here, so the answer is given as JSON rather than in controls that could check nothing you type.",
};

/**
 * Why a schema the mapper drew is answered as JSON when the compiler never arrived.
 *
 * The sentence above it, one arm over: it says which arm this is and why the controls are
 * absent, and it deliberately does not say what is unchecked — the raw editor renders
 * {@link CHECKER_UNAVAILABLE} beneath the document for that, exactly as it renders the
 * reader's own detail on the uncompilable arm.
 */
const UNAVAILABLE_CHECKER_FALLBACK: SchemaFallback = {
  cause: "checker-unavailable",
  memberPath: [],
  detail:
    "The part of this window that checks an answer against a schema did not load, so the controls that would have relied on it are not drawn and the answer is given as JSON.",
};

/**
 * Which validator states send a drawn schema to the raw editor, and with which sentence.
 *
 * A table total over the union rather than a comparison per arm, so an arm added to
 * {@link SchemaValidatorState} has to DECIDE here — a condition written as `!==` answered
 * for the new arm by accident, and the accident it answered with was "keep the controls",
 * which is the failing side.
 */
const RAW_ARM_FALLBACKS: Record<SchemaValidatorState["status"], SchemaFallback | undefined> = {
  compiling: undefined,
  compiled: undefined,
  uncompilable: UNCHECKABLE_SCHEMA_FALLBACK,
  "checker-unavailable": UNAVAILABLE_CHECKER_FALLBACK,
};

/**
 * The arm a form opens on: the mapper's reading, unless nothing could check it.
 *
 * COMPILING KEEPS THE MAPPER'S ARM, and the alternative is worse in both directions. The
 * drawn controls are what this schema will be answered in if it compiles, so opening them
 * is opening the form a person is about to use; opening the raw editor instead would show
 * a fallback whose stated reason — that the schema could not be compiled — is not yet
 * known to be true, and would then take it away. What a drawn control promises while the
 * compiler is arriving is kept by the act being closed rather than by the arm being moved:
 * nothing can be submitted until the verdict exists.
 *
 * A FAILED FETCH MOVES THE ARM FOR THE SAME REASON A REFUSED COMPILE DOES. A drawn control
 * promises the form will refuse a wrong value in it, and a window with no compiler cannot
 * keep that promise any better than a schema that would not compile — the two differ in
 * the sentence they carry and in nothing else here.
 */
export function armFor(plan: SchemaFormPlan, validator: SchemaValidatorState): SchemaFormPlan {
  const fallback = RAW_ARM_FALLBACKS[validator.status];
  if (plan.shape === "raw" || fallback === undefined) {
    return plan;
  }
  return { shape: "raw", fallback };
}
