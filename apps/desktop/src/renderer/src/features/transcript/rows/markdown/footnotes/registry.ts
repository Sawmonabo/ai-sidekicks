// One footnote registry per transcript row (each row mints its own), keyed by (source,
// identifier): a GFM identifier is scoped to its own message, so a lookup can only find a
// definition its own message declared.
// It is an external store (`definitionsFor` snapshot plus `subscribeToSource`) because writes come
// from an effect, and a plain read during render would stay stale after the last frame.

import type { RootContent } from "mdast";

import type { Unsubscribe } from "#shared/preload-api.js";
import { Emitter } from "#renderer/lib/emitter.js";

/**
 * Footnote definitions one transcript's registry retains. A definition belongs to a message
 * and a log holds `TRANSCRIPT_WINDOW_ROW_CAP` rows, so a few per retained row is everything
 * that can be opened.
 */
export const FOOTNOTE_DEFINITION_CAP = 2048;

/**
 * The separator the composite key is built with. NUL, because labels may contain spaces, colons
 * and slashes; an event id is a wire identifier, and commonmark replaces a literal NUL in a
 * label with U+FFFD, so neither half can hold one. Written as an escape so a diff shows it.
 */
const FOOTNOTE_KEY_SEPARATOR = "\u0000";

/** One definition, as its reader renders it. */
export interface FootnoteDefinition {
  /** The row this definition was declared in — the first half of the key. */
  readonly sourceId: string;
  /** The GFM identifier, wire-verbatim from the message text. */
  readonly identifier: string;
  /**
   * The definition's body as parsed nodes, not rendered elements: the reader maps them when it
   * draws them, so registration stays a fact about the parse rather than a write during render.
   */
  readonly bodyNodes: readonly RootContent[];
}

/** One row's footnote definitions, as an external store read through `definitionsFor`. */
export class FootnoteRegistry {
  readonly #definitionsByKey = new Map<string, FootnoteDefinition>();
  /** One source's definitions, held until that source's set changes. */
  readonly #viewsBySource = new Map<string, ReadonlyMap<string, FootnoteDefinition>>();
  readonly #changes = new Emitter<string>("footnote definition change");
  /**
   * The view for a source with no definitions: one shared instance, since a snapshot whose
   * identity changed on every read would spin `useSyncExternalStore`.
   */
  readonly #emptyDefinitions: ReadonlyMap<string, FootnoteDefinition> = new Map();

  /**
   * Records a definition under its own source. Bounded and oldest-first, so a message that
   * declares more notes than the cap keeps its newest.
   *
   * Recency refreshes on every call, but sinks are told only when a body actually moved or was
   * evicted, so a reader showing an evicted note is told.
   */
  public register(definition: FootnoteDefinition): void {
    const key = footnoteKey(definition.sourceId, definition.identifier);
    const held = this.#definitionsByKey.get(key);
    this.#definitionsByKey.delete(key);
    this.#definitionsByKey.set(key, definition);
    const changedSources = new Set<string>();
    if (held?.bodyNodes !== definition.bodyNodes) {
      changedSources.add(definition.sourceId);
    }
    while (this.#definitionsByKey.size > FOOTNOTE_DEFINITION_CAP) {
      const oldest = this.#definitionsByKey.keys().next();
      if (oldest.done === true) {
        break;
      }
      this.#definitionsByKey.delete(oldest.value);
      changedSources.add(sourceOfKey(oldest.value));
    }
    this.#announce(changedSources);
  }

  /**
   * Every definition one source declared, keyed by identifier: the store's snapshot. Empty when
   * none has arrived (a stream can carry `[^1]` several frames before `[^1]: ...`).
   *
   * Held after the first build because `useSyncExternalStore` compares by identity. The empty
   * answer is not held, so the cache stays bounded by the definitions the cap allows.
   */
  public definitionsFor(sourceId: string): ReadonlyMap<string, FootnoteDefinition> {
    const held = this.#viewsBySource.get(sourceId);
    if (held !== undefined) {
      return held;
    }
    const prefix = sourceId + FOOTNOTE_KEY_SEPARATOR;
    const view = new Map<string, FootnoteDefinition>();
    for (const [key, definition] of this.#definitionsByKey) {
      if (key.startsWith(prefix)) {
        view.set(definition.identifier, definition);
      }
    }
    if (view.size === 0) {
      return this.#emptyDefinitions;
    }
    this.#viewsBySource.set(sourceId, view);
    return view;
  }

  /**
   * Hears about one source's definitions changing while its body is mounted. A change to any
   * other source's definitions is not heard.
   */
  public subscribeToSource(sourceId: string, onChange: () => void): Unsubscribe {
    return this.#changes.subscribe((changedSourceId) => {
      if (changedSourceId === sourceId) {
        onChange();
      }
    });
  }

  /**
   * Retires the stale views, then tells the sinks, in that order: a sink reads the snapshot
   * back synchronously, so announcing before invalidating would hand it a stale view.
   */
  #announce(changedSources: ReadonlySet<string>): void {
    for (const sourceId of changedSources) {
      this.#viewsBySource.delete(sourceId);
    }
    for (const sourceId of changedSources) {
      this.#changes.emit(sourceId);
    }
  }
}

/** The composite key, in one place, so register and the snapshot cannot drift apart. */
function footnoteKey(sourceId: string, identifier: string): string {
  return sourceId + FOOTNOTE_KEY_SEPARATOR + identifier;
}

/**
 * The source half of a composite key, for naming what an eviction changed. Total on purpose:
 * `key.slice(0, key.indexOf(SEPARATOR))` on a key without a separator would name a source one
 * character short and invalidate nothing.
 */
function sourceOfKey(key: string): string {
  const boundary = key.indexOf(FOOTNOTE_KEY_SEPARATOR);
  return boundary === -1 ? key : key.slice(0, boundary);
}
