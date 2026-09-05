// The two subjects every subject-keyed suite in this family is addressed at.
//
// A subject is compared by IDENTITY — that is the whole of what `object` means in
// `subject-scoped-state.ts` and in `generation-latch.ts` — so a fixture subject is
// one allocation with a name on it, and three suites declaring their own pair was
// three copies of the same two lines. One home instead: the identities are shared,
// which is exactly what makes "the holder is at subject one, not subject two" the
// same sentence in each suite.
//
// A test-support module rather than a constant in one suite that the others import:
// a test file importing another test file makes one suite's cases a dependency of
// another's, and the shared walk under `test/console/console-source-modules.ts`
// excludes `.test-support.*` from the source-text gates exactly as it excludes tests.

/** A subject, named so a failure message can say which one a value belonged to. */
export interface NamedFixtureSubject {
  readonly name: string;
}

/** The subject a surface starts addressed at. */
export const SUBJECT_ONE: NamedFixtureSubject = { name: "subject one" };

/** The subject it is re-addressed to, and back from. */
export const SUBJECT_TWO: NamedFixtureSubject = { name: "subject two" };
