// Read-only maps a transcript window publishes on every admitted event without copying a whole-log
// map: a native `Map` copy of a few thousand rows costs a fifth of a millisecond. Each is a view,
// over one published list and a key index or over another map and a membership rule, that answers
// exactly what a map built from what it views would, and never changes once published.

/**
 * What every map here answers the same way, from its own entries: iteration in entry order, and
 * the callback walk.
 */
abstract class MapView<TValue> implements ReadonlyMap<string, TValue> {
  public abstract readonly size: number;

  public abstract get(key: string): TValue | undefined;

  public abstract has(key: string): boolean;

  public abstract entries(): MapIterator<[string, TValue]>;

  public forEach(
    callback: (value: TValue, key: string, map: ReadonlyMap<string, TValue>) => void,
    thisArgument?: unknown,
  ): void {
    for (const [key, value] of this.entries()) {
      callback.call(thisArgument, value, key, this);
    }
  }

  public *keys(): MapIterator<string> {
    for (const [key] of this.entries()) {
      yield key;
    }
  }

  public *values(): MapIterator<TValue> {
    for (const [, value] of this.entries()) {
      yield value;
    }
  }

  public [Symbol.iterator](): MapIterator<[string, TValue]> {
    return this.entries();
  }
}

/**
 * A map over one published list, each entry filed under a key it carries. A lookup goes through a
 * position index that later lists share, and is answered only when the entry at that position
 * still carries the key, so a key that moved on (a reply's foot) or lies past this list's end reads
 * as absent. A key repeated in the list answers its last entry, as a `Map` built by setting each
 * entry in turn would; that entry is also where iteration yields it.
 */
export class ListKeyedMap<TEntry, TValue> extends MapView<TValue> {
  readonly #entries: readonly TEntry[];
  readonly #positionByKey: ReadonlyMap<string, number>;
  readonly #keyOf: (entry: TEntry) => string;
  readonly #valueOf: (entry: TEntry) => TValue;
  public override readonly size: number;

  /** `size` is the count of distinct keys `entries` carries, which the caller has kept. */
  public constructor(
    entries: readonly TEntry[],
    positionByKey: ReadonlyMap<string, number>,
    keyOf: (entry: TEntry) => string,
    valueOf: (entry: TEntry) => TValue,
    size: number,
  ) {
    super();
    this.#entries = entries;
    this.#positionByKey = positionByKey;
    this.#keyOf = keyOf;
    this.#valueOf = valueOf;
    this.size = size;
  }

  public override get(key: string): TValue | undefined {
    const entry = this.#entryFiledUnder(key);
    return entry === undefined ? undefined : this.#valueOf(entry);
  }

  public override has(key: string): boolean {
    return this.#entryFiledUnder(key) !== undefined;
  }

  public override *entries(): MapIterator<[string, TValue]> {
    for (let position = 0; position < this.#entries.length; position += 1) {
      const entry = this.#entries[position] as TEntry;
      const key = this.#keyOf(entry);
      if (this.#positionByKey.get(key) === position) {
        yield [key, this.#valueOf(entry)];
      }
    }
  }

  #entryFiledUnder(key: string): TEntry | undefined {
    const position = this.#positionByKey.get(key);
    if (position === undefined || position >= this.#entries.length) {
      return undefined;
    }
    const entry = this.#entries[position] as TEntry;
    return this.#keyOf(entry) === key ? entry : undefined;
  }
}

/**
 * The entries of `source` that `isMember` admits, in `source`'s order. A lookup asks the rule of
 * one entry; the size is the count the caller kept, or a walk on first read when it kept none.
 */
export class FilteredMap<TValue> extends MapView<TValue> {
  readonly #source: ReadonlyMap<string, TValue>;
  readonly #isMember: (key: string, value: TValue) => boolean;
  #size: number | undefined;

  /** `size`, when given, is the count of `source`'s entries `isMember` admits. */
  public constructor(
    source: ReadonlyMap<string, TValue>,
    isMember: (key: string, value: TValue) => boolean,
    size?: number,
  ) {
    super();
    this.#source = source;
    this.#isMember = isMember;
    this.#size = size;
  }

  public override get size(): number {
    this.#size ??= [...this.entries()].length;
    return this.#size;
  }

  public override get(key: string): TValue | undefined {
    const value = this.#source.get(key);
    return value !== undefined && this.#isMember(key, value) ? value : undefined;
  }

  public override has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  public override *entries(): MapIterator<[string, TValue]> {
    for (const [key, value] of this.#source) {
      if (this.#isMember(key, value)) {
        yield [key, value];
      }
    }
  }
}
