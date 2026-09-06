// The footnote registry — one per timeline, keyed by source.
//
// `Spec-023 §Console Libraries`, streaming-markdown row, OWN-BUILDs "the footnote
// registry" and says nothing about how it is keyed. THIS MODULE DECIDES THAT, and the
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

  /**
   * Record a definition under its own source.
   *
   * Bounded, and eviction is oldest-first for the reason the cap's own rationale in
   * `core/constants.ts` gives: a
   * definition belongs to the message that carried it, the window retains a bounded
   * number of messages, and a definition older than the window's oldest row can never
   * be opened because the reference that would open it is gone too.
   */
  public register(definition: FootnoteDefinition): void {
    const key = footnoteKey(definition.sourceId, definition.identifier);
    this.#definitionsByKey.delete(key);
    this.#definitionsByKey.set(key, definition);
    while (this.#definitionsByKey.size > FOOTNOTE_DEFINITION_CAP) {
      const oldest = this.#definitionsByKey.keys().next();
      if (oldest.done === true) {
        return;
      }
      this.#definitionsByKey.delete(oldest.value);
    }
  }

  /**
   * The definition this reference resolves to, or `undefined`.
   *
   * `undefined` is the honest answer for a reference whose definition has not arrived
   * yet — a stream can carry `[^1]` several frames before `[^1]: …` — and the mapper
   * renders the marker with no popover rather than an empty one.
   */
  public resolve(sourceId: string, identifier: string): FootnoteDefinition | undefined {
    return this.#definitionsByKey.get(footnoteKey(sourceId, identifier));
  }

  /** Drop every definition one source declared, when its row leaves the window. */
  public forgetSource(sourceId: string): void {
    const prefix = sourceId + FOOTNOTE_KEY_SEPARATOR;
    for (const key of [...this.#definitionsByKey.keys()]) {
      if (key.startsWith(prefix)) {
        this.#definitionsByKey.delete(key);
      }
    }
  }

  public get definitionCount(): number {
    return this.#definitionsByKey.size;
  }
}

/** The composite key, in one place, so register and resolve cannot drift apart. */
function footnoteKey(sourceId: string, identifier: string): string {
  return sourceId + FOOTNOTE_KEY_SEPARATOR + identifier;
}
import { FOOTNOTE_DEFINITION_CAP } from "../../../core/index.js";
