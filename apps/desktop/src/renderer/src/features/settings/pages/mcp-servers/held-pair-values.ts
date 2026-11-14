// The values of one kind of name-and-value pair (environment variables, headers) that the add form
// holds until it sends or drops them: each one a pair's `Add` handed over, and each pair row still
// on screen, whose fields are read once the form is sent. Nothing here is React state, so no render
// or inspection of the form holds a value.

/** One pair row on screen, as the form reads it when it is sent. */
export interface PairRowFields {
  /** Reads the row's name and value and clears both fields; the pair where both were typed. */
  readonly take: () => TypedPair | undefined;
}

/** One kind of pair's values, held until the form that collects them is sent. */
export class HeldPairValues {
  readonly #addedValues = new Map<string, string>();
  readonly #rows = new Set<PairRowFields>();

  /** Holds the value a pair's `Add` handed over, in place of one held under the same name. */
  public add(name: string, value: string): void {
    this.#addedValues.set(name, value);
  }

  /** Reads `row` too when the form is sent, until the returned call lets it go. */
  public watch(row: PairRowFields): () => void {
    this.#rows.add(row);
    return () => {
      this.#rows.delete(row);
    };
  }

  /**
   * Every value held and every row typed whole, as the request's record, a row's own value taking
   * the place of one added under its name. Clears every row's fields and every held value in the
   * same step, so none outlives the send.
   */
  public take(): Record<string, string> {
    for (const row of this.#rows) {
      const typed = row.take();
      if (typed !== undefined) {
        this.#addedValues.set(typed.name, typed.value);
      }
    }
    const values = Object.fromEntries(this.#addedValues);
    this.#addedValues.clear();
    return values;
  }
}

/** A name and its value, typed into one pair row. */
interface TypedPair {
  readonly name: string;
  readonly value: string;
}
