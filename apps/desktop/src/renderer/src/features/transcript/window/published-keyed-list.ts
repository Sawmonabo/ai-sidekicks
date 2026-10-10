// A list a transcript derivation grows across a log's appended stretches and publishes after each,
// as an array and as a map by key, without copying a whole-log map per stretch. The array is copied
// once per stretch that writes it, a pointer copy; the map is a view over that copy and a position
// index every copy shares.

import { ListKeyedMap } from "./map-views.js";

/**
 * Entries kept in order, appended or replaced in place, each filed under a key it carries. What
 * `list` and `map` hand out never changes afterwards: the next write works on a copy.
 */
export class PublishedKeyedList<TEntry, TValue> {
  readonly #keyOf: (entry: TEntry) => string;
  readonly #valueOf: (entry: TEntry) => TValue;
  #entries: TEntry[] = [];
  /** Whether `#entries` was handed out, so the next write must copy it first. */
  #isEntriesPublished = false;
  #positionByKey = new Map<string, number>();
  #repeatedKeyCount = 0;
  #map: ReadonlyMap<string, TValue> | undefined;

  public constructor(keyOf: (entry: TEntry) => string, valueOf: (entry: TEntry) => TValue) {
    this.#keyOf = keyOf;
    this.#valueOf = valueOf;
  }

  /** How many entries the list holds. */
  public get length(): number {
    return this.#entries.length;
  }

  /** The entry at `position`, or `undefined` past the end. */
  public at(position: number): TEntry | undefined {
    return this.#entries[position];
  }

  /** Where the entry filed under `key` sits, or `undefined` for a key no entry carries now. */
  public positionOf(key: string): number | undefined {
    const position = this.#positionByKey.get(key);
    const entry = position === undefined ? undefined : this.#entries[position];
    return entry !== undefined && this.#keyOf(entry) === key ? position : undefined;
  }

  /** Append one entry, filed under its key. Answers its position. */
  public push(entry: TEntry): number {
    const entries = this.#writable();
    const position = entries.length;
    entries.push(entry);
    this.#file(this.#keyOf(entry), position);
    return position;
  }

  /** Put `entry` at `position` in place of the entry there, filed under its own key. */
  public set(position: number, entry: TEntry): void {
    this.#writable()[position] = entry;
    this.#file(this.#keyOf(entry), position);
  }

  /** The entries as they stand, an array no later write changes. */
  public list(): readonly TEntry[] {
    this.#isEntriesPublished = true;
    return this.#entries;
  }

  /** The entries by key, as they stand; a view no later write changes. */
  public map(): ReadonlyMap<string, TValue> {
    this.#map ??= new ListKeyedMap(
      this.list(),
      this.#positionByKey,
      this.#keyOf,
      this.#valueOf,
      this.#entries.length - this.#repeatedKeyCount,
    );
    return this.#map;
  }

  #writable(): TEntry[] {
    if (this.#isEntriesPublished) {
      this.#entries = this.#entries.slice();
      this.#isEntriesPublished = false;
    }
    this.#map = undefined;
    return this.#entries;
  }

  // A key filed elsewhere before moves on a copy of the index, so a map published before the move
  // still finds the key where its own list has it. Only a key that entry still carries is a repeat.
  #file(key: string, position: number): void {
    const filedAt = this.#positionByKey.get(key);
    if (filedAt === position) {
      return;
    }
    if (filedAt !== undefined) {
      const filedEntry = this.#entries[filedAt];
      if (filedEntry !== undefined && this.#keyOf(filedEntry) === key) {
        this.#repeatedKeyCount += 1;
      }
      this.#positionByKey = new Map(this.#positionByKey);
    }
    this.#positionByKey.set(key, position);
  }
}
