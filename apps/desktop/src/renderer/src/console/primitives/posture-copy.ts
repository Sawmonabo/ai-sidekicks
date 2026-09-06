// The two sentences a posture surface says in words rather than in figures.
//
// THEIR OWN MODULE BECAUSE TWO COMPONENTS SAY THEM. The card presentation lives in
// `ExecutionPostureChip.tsx` and the row presentation in `PostureRow.tsx`, and a
// caveat written twice is a caveat that can be softened in one place and not the
// other — which is exactly the drift the enforcement sentence exists to prevent.
// Neither is exported through the family door: both readers are this family's own.

/**
 * What an absent posture means, said once so no arm reads it as permissive.
 *
 * Absence is a non-running row or a row from before the stamp was recorded. It is
 * NOT `trusted`, and the sentence says so rather than leaving a reader to infer it.
 */
export const POSTURE_ABSENT_DETAIL =
  "A posture is stamped when a run reaches running. A row that is not running, or one from before the posture was recorded, carries none — which is not the same as an unrestricted one.";

/**
 * The enforcement caveat the corpus states, rendered wherever the facts are.
 *
 * It travels with the FACTS and not with the mode label, because it is a statement
 * about what the label does not promise — a surface that showed the facts without it
 * would be presenting a mode as a uniform operating-system boundary, which on the
 * Claude leg it is not.
 */
export const POSTURE_ENFORCEMENT_CAVEAT =
  "A mode label does not imply uniform enforcement by the operating system. On the Claude leg enforcement is scoped to the Bash tool, and non-Bash tools are bound through the permission system instead.";
