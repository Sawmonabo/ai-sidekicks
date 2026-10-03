// The two subjects every subject-keyed suite is addressed at. A subject is an `object` compared by
// reference (see `lib/subject-scoped/subject-scoped-holder.ts`), so each fixture is one shared
// allocation with a name on it. It has its own module so no suite imports another suite's file.

/** A subject, named so a failure message can say which one a value belonged to. */
export interface NamedFixtureSubject {
  readonly name: string;
}

/** The subject a component starts addressed at. */
export const SUBJECT_ONE: NamedFixtureSubject = { name: "subject one" };

/** The subject it is re-addressed to, and back from. */
export const SUBJECT_TWO: NamedFixtureSubject = { name: "subject two" };
