// The subjects and the open/close ledger both resource suites are driven with.
//
// One home for what `subject-scoped-resource.test.tsx` and
// `subject-scoped-dropped-pass.test.tsx` share. The ledger is the whole instrument in
// both — a leak and a double close are the two failures these suites exist to see, and
// they are only visible if opens and closes are counted BY NAME against one record. A
// second copy of it would be two records that agree until one of them stops counting
// something, which is precisely the failure it is watching for.
//
// The subjects are named for the roles these two suites put them in rather than shared
// with `subject-fixtures.test-support.ts`, because the ledger prints the name and
// "discarded" says what the case is about where "subject one" does not. The TYPE is
// that module's: two one-field interfaces meaning "a fixture subject with a name" in
// one directory is the second implementation this package's rules forbid.

import type { NamedFixtureSubject } from "./subject-fixtures.test-support.js";

/** The subject the pass React throws away is addressed at. */
export const DISCARDED_SUBJECT: NamedFixtureSubject = { name: "discarded" };

/** The subject the pass that actually commits is addressed at. */
export const SETTLED_SUBJECT: NamedFixtureSubject = { name: "settled" };

/** What one of these owns is nothing at all; being opened and closed is the whole of it. */
export interface OpenResource {
  readonly name: string;
}

/** Every open and every close, in order, so a double close is as visible as a leak. */
export class ResourceLedger {
  readonly #opened: string[] = [];
  readonly #closed: string[] = [];

  public open(name: string): OpenResource {
    this.#opened.push(name);
    return { name };
  }

  /**
   * Bound, because the hook takes it as a dependency.
   *
   * A method passed as `ledger.close` would be unbound; an arrow at the call site
   * would be a new identity every render, which is the shape the hook's own doc says
   * a caller should not write.
   */
  public readonly close = (resource: OpenResource): void => {
    this.#closed.push(resource.name);
  };

  public get opened(): readonly string[] {
    return [...this.#opened];
  }

  public get closed(): readonly string[] {
    return [...this.#closed];
  }
}
