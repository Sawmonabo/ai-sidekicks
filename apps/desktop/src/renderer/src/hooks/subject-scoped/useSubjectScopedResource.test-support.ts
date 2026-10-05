// The subjects and the open/close ledger the resource tests are driven with.
//
// The ledger is the whole instrument: a leak and a double close are the two failures these
// suites exist to see, and they are visible only if opens and closes are counted by name
// against one record. A second copy would be two records that agree until one stops counting
// something.
//
// The subjects are named for the roles these suites give them ("discarded" says what the
// case is about where "subject one" does not), while the type is
// `NamedFixtureSubject` from `#test/helpers/subject-fixtures.js`.

import type { NamedFixtureSubject } from "#test/helpers/subject-fixtures.js";

/** The subject the pass React throws away is addressed at. */
export const DISCARDED_SUBJECT: NamedFixtureSubject = { name: "discarded" };

/** The subject the pass that actually commits is addressed at. */
export const SETTLED_SUBJECT: NamedFixtureSubject = { name: "settled" };

/** A resource is only opened and closed; the name is what the ledger records. */
export interface OpenResource {
  readonly name: string;
}

/** Every open and every close, in order, so a double close is as visible as a leak. */
export class ResourceOpenCloseLog {
  readonly #opened: string[] = [];
  readonly #closed: string[] = [];
  readonly #closedResources = new WeakSet<OpenResource>();

  /**
   * Bound, because the hook takes it as a dependency.
   *
   * A method passed as `ledger.close` would be unbound, and an arrow at the call site would
   * be a new identity every render.
   */
  public readonly close = (resource: OpenResource): void => {
    this.#closed.push(resource.name);
    this.#closedResources.add(resource);
  };

  /**
   * Whether this resource has been closed; the reading a terminal `close` hands the hook.
   *
   * By identity, never by name: every resource a subject opens carries the subject's name, so
   * a name-keyed reading would call a re-minted replacement closed the moment it was born and
   * the hook would re-mint forever. Bound for the reason `close` is.
   */
  public readonly isClosed = (resource: OpenResource): boolean =>
    this.#closedResources.has(resource);

  public open(name: string): OpenResource {
    this.#opened.push(name);
    return { name };
  }

  public get opened(): readonly string[] {
    return [...this.#opened];
  }

  public get closed(): readonly string[] {
    return [...this.#closed];
  }
}
