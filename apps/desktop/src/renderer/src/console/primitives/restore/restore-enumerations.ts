import { type RollbackInterventionResult } from "@ai-sidekicks/contracts"; // The two path enumerations a rollback result carries, read off the wire shape.
//
// A MODEL BESIDE ITS COMPONENTS. The disclosure derives these from the intervention
// result and the enumeration lists render them, so the derivation and its shape are
// the seam between the two — and declared in the disclosure they would close a cycle
// with the lists that read them.

/** The two never-silent enumerations, carried together because they are read together. */
export interface RestoreEnumerations {
  readonly overwrittenIgnoredPaths: readonly string[];
  readonly divergentGitlinks: readonly string[];
}

/**
 * The enumerations, where the disposition carries them.
 *
 * Narrowed on the discriminant rather than probed for the fields: the contract types
 * both as required on exactly these three arms, so this switch spends that guarantee
 * instead of re-deriving it. `resend-unapplied` is here for the reason the contract
 * records — it DISPLACES a completed file leg, so dropping its enumerations would
 * silence an overwritten path in precisely the case where the tree was mutated.
 */
export function restoreEnumerations(
  result: RollbackInterventionResult,
): RestoreEnumerations | undefined {
  switch (result.disposition) {
    case "files-restored":
    case "files-partially-restored":
    case "resend-unapplied":
      return {
        overwrittenIgnoredPaths: result.overwrittenIgnoredPaths,
        divergentGitlinks: result.divergentGitlinks,
      };
    default:
      return undefined;
  }
}
