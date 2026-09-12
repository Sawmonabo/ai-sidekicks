// The footnote registry — one per timeline, keyed by source.
//
// The footnote registry is own-built, and nothing above this module says how it is
// keyed. THIS MODULE DECIDES THAT, and the
// rule is: one popover host per timeline over a registry keyed by (source, identifier),
// so a definition line never resolves as its own body.
//
// THE FAILURE THE KEYING PREVENTS. GFM footnotes are `[^1]` for the reference and
// `[^1]: …` for the definition, and the identifier is scoped to the DOCUMENT. A ledger
// is not one document — it is hundreds of messages, each parsed separately, and `[^1]`
// means a different thing in each. A registry keyed by identifier alone would let
// message 40's definition answer message 3's reference, and — the case the rule above
// names outright — would let a definition line resolve as its own body, because a definition
// and its reference carry the same identifier inside the same message. Keying by
// (source, identifier) makes both unrepresentable: the source is the row the definition
// came from, so a lookup can only find a definition its own message declared.
//
// WHY A CLASS AND NOT A CONTEXT VALUE. Definitions arrive as blocks settle, from a
// parse that runs outside React, and references resolve during render. A `useState`
// holding this would re-render every row in the timeline each time any message declared
// a footnote. The registry is handed to the host; the host re-renders when a popover
// opens, which is the only moment its contents reach the screen.
//
// AND WHY IT IS STILL AN EXTERNAL STORE. A plain class with no subscription was read
// during render and written from an effect — `StreamingMarkdown`'s registration hook —
// so the write always landed AFTER the render that resolved it. While a body streams
// the next frame hides that; on the LAST frame there is no next frame, so a popover
// already open over a note the final update rewrote stayed on the penultimate body
// indefinitely. The remedy is one mechanism rather than two: this class is the store,
// `definitionsFor` is its snapshot, and `subscribeToSource` is what re-renders the one
// host whose body changed. There is deliberately no second lookup beside the snapshot —
// a read that bypassed the subscription is exactly the stale read this closes.
//
// THE SNAPSHOT IS PER SOURCE, AND STABLE. `useSyncExternalStore` compares snapshots by
// identity, so `definitionsFor` hands back a view held until that source's definitions
// actually change: a re-registration of the identical parse — the ordinary case on a
// frame that changed nothing about this note, since a settled block's nodes are
// referentially stable — is not a change and notifies nobody.

import type { RootContent } from "mdast";

/**
 * The separator the composite key is built with.
 *
 * NUL, because a GFM footnote label may contain spaces, colons, and slashes — every
 * separator a reader reaches for first — and two different (source, identifier) pairs
 * that concatenated to one string would resolve each other's definitions, which is the
 * exact failure the composite key exists to prevent. NUL occurs in neither half: an
 * event id is a wire identifier, and a label arrives from text micromark has already
 * decoded, where commonmark replaces a literal NUL with U+FFFD. Written as an escape
 * rather than typed, so a reader and a diff can both see it.
 */
const FOOTNOTE_KEY_SEPARATOR = "\u0000";

/** One definition, as the popover renders it. */
export interface FootnoteDefinition {
  /** The row this definition was declared in — the first half of the key. */
  readonly sourceId: string;
  /** The GFM identifier, wire-verbatim from the message text. */
  readonly identifier: string;
  /**
   * The definition's body, as parsed nodes rather than as rendered elements.
   *
   * The popover host maps them when it opens, which is what keeps registration a pure
   * fact about the parse: a registry holding elements would have to be written during a
   * render, and `apps/desktop/AGENTS.md` puts every such write in a class or a hook.
   */
  readonly bodyNodes: readonly RootContent[];
}

export class FootnoteRegistry {
  readonly #definitionsByKey = new Map<string, FootnoteDefinition>();
  /** One source's definitions, held until that source's set changes. See the header. */
  readonly #viewsBySource = new Map<string, ReadonlyMap<string, FootnoteDefinition>>();
  readonly #changes = new Emitter<string>("footnote definition change");
  /**
   * The view a source with no definitions is answered with.
   *
   * An instance field rather than a module constant, so it is a value this registry
   * owns instead of the module-level mutable singleton `apps/desktop/AGENTS.md`
   * rejects — and one instance rather than a fresh `Map` per call, because a snapshot
   * that changed identity on every read would spin `useSyncExternalStore` forever.
   */
  readonly #emptyDefinitions: ReadonlyMap<string, FootnoteDefinition> = new Map();

  /**
   * Record a definition under its own source.
   *
   * Bounded, and eviction is oldest-first for the reason the cap's own rationale in
   * `core/constants/ledger-card-caps.ts` gives: a
   * definition belongs to the message that carried it, the window retains a bounded
   * number of messages, and a definition older than the window's oldest row can never
   * be opened because the reference that would open it is gone too.
   *
   * The recency refresh happens whichever way the comparison below goes — a definition
   * a live card re-registered is not old — while the ANNOUNCEMENT is made only for a
   * body that actually moved. An evicted definition announces too, and for the same
   * reason a rewritten one does: a popover open over it is showing something the
   * registry no longer holds.
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
   * Every definition one source declared, keyed by identifier — the store's snapshot.
   *
   * An empty map is the honest answer for a body whose definitions have not arrived
   * yet — a stream can carry `[^1]` several frames before `[^1]: …` — and the host
   * renders the marker with no body rather than an empty popup.
   *
   * Built on demand and then HELD, because identity is what
   * `useSyncExternalStore` compares: rebuilding per read would report a change on every
   * render. The empty answer is not held, because it is already one shared value and a
   * cache entry per source ever asked about would grow with every row the window
   * rendered rather than with the definitions the cap bounds.
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
   * Hear about one source's definitions changing, for as long as its body is mounted.
   *
   * Scoped to the source rather than to the registry, because one registry serves every
   * row in the ledger: an unscoped signal would re-render every mounted popover host
   * each time any message declared a note, which is the fan-out this class exists to
   * avoid. The filter is here rather than in the caller so the two halves of the
   * scoping — which key a change names and which key a host waits on — stay in one
   * module.
   */
  public subscribeToSource(sourceId: string, onChange: () => void): Unsubscribe {
    return this.#changes.subscribe((changedSourceId) => {
      if (changedSourceId === sourceId) {
        onChange();
      }
    });
  }

  /** Drop every definition one source declared, when its row leaves the window. */
  public forgetSource(sourceId: string): void {
    const prefix = sourceId + FOOTNOTE_KEY_SEPARATOR;
    for (const key of [...this.#definitionsByKey.keys()]) {
      if (key.startsWith(prefix)) {
        this.#definitionsByKey.delete(key);
      }
    }
    this.#announce(new Set([sourceId]));
  }

  public get definitionCount(): number {
    return this.#definitionsByKey.size;
  }

  /**
   * Retire the stale views, then tell the sinks — in that order and not interleaved.
   *
   * A sink reads the snapshot back synchronously (React's does, while deciding whether
   * to re-render), so announcing one source before invalidating the next would hand a
   * reader a view this very call has already made wrong.
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
 * The source half of a composite key, for naming what an eviction changed.
 *
 * Total by construction — every key is {@link footnoteKey}'s, and NUL occurs in neither
 * half for the reason the separator's own rationale gives — and written totally anyway,
 * because the natural one-liner `key.slice(0, key.indexOf(SEPARATOR))` on a key without
 * one would silently name a source one character short and invalidate nothing.
 */
function sourceOfKey(key: string): string {
  const boundary = key.indexOf(FOOTNOTE_KEY_SEPARATOR);
  return boundary === -1 ? key : key.slice(0, boundary);
}
import { Emitter, FOOTNOTE_DEFINITION_CAP, type Unsubscribe } from "../../../../core/index.js";
