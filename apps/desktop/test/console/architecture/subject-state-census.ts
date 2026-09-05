// The state-cell census the subject chokepoint next door runs: what a module declares or
// publishes, and which of its mount-lifetime cells capture a subject by hand.
//
// A MODEL BESIDE ITS GATE, on the `barrel-census.ts` pattern, and for the same reason:
// the gate reads the real console while its controls read corpora written by hand to
// fail, so the predicates take source text as a parameter and the walk that produces the
// real one stays in the gate, where `source-walk-chokepoint.test.ts` can see it. The two
// jobs had grown into one 552-line file, which is the size at which a reader stops being
// able to tell the rule from the tree it is run against.
//
// CLAIM 2 READS SIX HOOKS, and they are the ordinary React holders plus the two that
// hold for a mount's lifetime without looking like storage: `useState`, `useRef`,
// `useMemo`, `useReducer`, `useCallback`, and `useEffect`. A callback naming a subject
// in its body and not in its dependencies holds a retired transport exactly as a memo
// does — it is invoked later, against whatever it closed over — and an effect with an
// EMPTY dependency list subscribes once and keeps what it captured for the whole mount.
// Both were invisible to a scan that read four hooks, and both are two lines a component
// writes without deciding anything.
//
// What separates a holder from a DERIVATION is the dependency list, so that is what this
// reads: a memo or a callback naming a bridge in its body AND in its dependencies is
// rebuilt when the bridge moves, which is correct and is not flagged; one that names it
// in the body alone is a value keyed on a subject it will never be produced for again.
// `useState`, `useRef`, and `useReducer` have no dependency list, so every subject they
// name is flagged. `useEffect` is read only under the empty list: with any dependency it
// re-runs when that dependency moves, and with no list at all it re-runs every render,
// so neither shape is the capture this claim is about.
//
// CLAIM 2 IS COARSE ON PURPOSE, and it offers NO EXEMPTION LIST. It flags a
// `useState(() => new SomethingBoundTo(bridge))` even where that something disposes
// itself correctly, and it flags a `useRef` holding a mutable handle that is never
// rendered. Both are the class this file is about — a value whose lifetime is a
// subject's kept in a cell whose lifetime is a mount's — so the only answer is to go
// through the holder. It is case-sensitive: `BridgeScopedLatch` in an initialiser is a
// construction and not a captured subject, and only the lower-case identifiers a
// component receives as props are the signature.
//
// WHAT IT DOES NOT REACH, said plainly rather than left to be discovered: a subject read
// through a local alias (`const transport = bridge` and then a cell naming `transport`);
// a declaration nested inside a function body rather than at a module's top level; an
// effect whose dependency list is neither empty nor the subject, which re-runs on
// something else and can still close over a retired one; and a subject reached through a
// custom hook this file does not name, since only React's own six are read. Each needs a
// parser or a resolver rather than a source-text scan; the claim here is the coarse one,
// and none of these is the shape a copy is written in.
//
// THE INSTRUMENT IS SOURCE TEXT, and it has to be: whether a component keeps a subject
// in a cell whose lifetime is a mount's is a property of what somebody wrote, which no
// type and no runtime value reports.

/**
 * The names the six replaced copies went by, as one expression.
 *
 * One hook shape and one suffix family. A hook pairs a SUBJECT word with a scoping or a
 * state word, and the two may be separated: `useBridgeKeyedState` is the same object
 * with a word between the halves, and it passed the two rigid alternatives this
 * replaced, which required the second word to follow the subject immediately.
 *
 * The suffixes are the class names. `Latch$`, `Register$`, and `Epoch$` are anchored
 * because a state type named for one — `MutationAttemptState` — is a caller's own
 * vocabulary and not a second latch, and because an anchored `Register` does not sweep
 * in a `Registry`. `Generation` is NOT anchored: it was a whole class, and
 * `SessionGenerationCounter` is that class under a prefix AND a suffix, which an
 * anchored form missed.
 *
 * The subject words are deliberately not paired with `Store`: `useSessionStore` and
 * `useSessionStoreRegistry` are reads of a store this console already has one of, and
 * a naming rule that swept them in would be answered by renaming rather than by going
 * through the holder.
 */
export const SECOND_IMPLEMENTATION_NAMES =
  /use(?:Subject|Session|Bridge|Pane|Run|Agent)[A-Za-z]*?(?:Scoped|Stamped|State|Value|Holder)|(?:Latch|Register|Epoch)$|Generation|MutationAttempt$/;

/** What a hand-rolled holder captures: the two identities a surface is addressed by. */
const SUBJECT_IDENTIFIERS: readonly string[] = ["bridge", "sessionId"];

/** The React hooks that hold a value for the life of a mount. */
const STATE_CELL_HOOKS = /\buse(State|Ref|Memo|Reducer|Callback|Effect)\s*(?:<[^;=]*?>)?\s*\(/g;

/** The dependency list that makes a hook a mount-lifetime capture rather than a rerun. */
const EMPTY_DEPENDENCY_LIST = "[]";

/** Openers whose closer has to be counted before a comma can be a top-level one. */
const ARGUMENT_GROUPINGS: Readonly<Record<string, string>> = { "(": ")", "[": "]", "{": "}" };

/**
 * Every name `source` DECLARES at its top level, exported or not.
 *
 * Separate from the re-export specifiers below because the two answer different
 * questions: what a module implements, and what it merely publishes. The door rule
 * rests on the first — a module that only forwards declares nothing.
 */
export function declaredSymbolNames(source: string): readonly string[] {
  return [
    ...source.matchAll(
      /^(?:export\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm,
    ),
  ]
    .map((match) => match[1] ?? "")
    .filter((name) => name.length > 0);
}

/** Every name `source` publishes from somewhere else, through an export specifier. */
export function reExportedSymbolNames(source: string): readonly string[] {
  return [...source.matchAll(/^export\s+(?:type\s+)?\{([^}]*)\}/gm)]
    .flatMap((match) =>
      (match[1] ?? "")
        .split(",")
        .map((specifier) => specifier.replace(/\/\*[\s\S]*?\*\//g, "").trim())
        .filter((specifier) => specifier.length > 0)
        // `A as B` exports B; a bare `A` exports A. `type` prefixes are stripped.
        .map(
          (specifier) =>
            specifier
              .split(/\s+as\s+/)
              .at(-1)
              ?.replace(/^type\s+/, "")
              .trim() ?? "",
        ),
    )
    .filter((name) => name.length > 0);
}

/**
 * Every name a module either declares or publishes, which is what claim 1 scans.
 *
 * Both halves, because a copy is reachable either way: written in place, or written
 * elsewhere and re-exported into position by a barrel.
 */
export function moduleSymbolNames(source: string): readonly string[] {
  return [...declaredSymbolNames(source), ...reExportedSymbolNames(source)];
}

/** One state cell: what becomes the held value, and what would re-derive it. */
export interface StateCell {
  /** The argument texts that produce the value the cell holds. */
  readonly held: readonly string[];
  /** The argument texts that decide when it is produced again. Empty where none can. */
  readonly dependencies: readonly string[];
}

/**
 * Split one call's argument text at its top-level commas.
 *
 * Grouping-aware rather than a plain split, because every interesting argument here is
 * a function body, an object literal, or a dependency array, and each carries commas
 * of its own. A dependency list is an argument like any other, so a scan that could not
 * tell one argument from the next could not tell a holder from a derivation.
 */
export function splitTopLevelArguments(text: string): readonly string[] {
  const argumentTexts: string[] = [];
  const closers: string[] = [];
  let start = 0;
  for (let cursor = 0; cursor < text.length; cursor += 1) {
    const character = text[cursor] ?? "";
    const closer = ARGUMENT_GROUPINGS[character];
    if (closer !== undefined) {
      closers.push(closer);
    } else if (closers.length > 0 && character === closers.at(-1)) {
      closers.pop();
    } else if (character === "," && closers.length === 0) {
      argumentTexts.push(text.slice(start, cursor));
      start = cursor + 1;
    }
  }
  argumentTexts.push(text.slice(start));
  return argumentTexts.map((argumentText) => argumentText.trim()).filter((text) => text.length > 0);
}

/**
 * Every mount-lifetime state cell in `source`, split into what it holds and what
 * re-derives it.
 *
 * Balanced-paren scanning rather than a single regular expression: an initialiser is
 * routinely a function body containing its own parentheses, and a lazy match would
 * stop at the first one and read a fragment.
 *
 * Which argument holds the value is the hook's own answer and differs per hook.
 * `useState` and `useRef` take one and it is the seed. `useMemo` takes a factory and
 * then the dependencies that decide when it runs again. `useReducer` takes a reducer
 * FIRST and the initial state after it, so its held text is everything but the first
 * argument — and it has no dependency list at all, which is exactly why it is a holder.
 */
export function stateCells(source: string): readonly StateCell[] {
  const cells: StateCell[] = [];
  for (const opening of source.matchAll(STATE_CELL_HOOKS)) {
    const start = opening.index + opening[0].length;
    let depth = 1;
    let cursor = start;
    while (cursor < source.length && depth > 0) {
      const character = source[cursor];
      if (character === "(") {
        depth += 1;
      } else if (character === ")") {
        depth -= 1;
      }
      cursor += 1;
    }
    const argumentTexts = splitTopLevelArguments(source.slice(start, cursor - 1));
    if (opening[1] === "Memo" || opening[1] === "Callback") {
      cells.push({ held: argumentTexts.slice(0, 1), dependencies: argumentTexts.slice(1) });
    } else if (opening[1] === "Reducer") {
      cells.push({ held: argumentTexts.slice(1), dependencies: [] });
    } else if (opening[1] === "Effect") {
      // An effect holds nothing by itself, so it counts only where its dependency list
      // is EMPTY: that is the arm that subscribes once and keeps whatever it closed over
      // for the life of the mount. An effect with any dependency re-runs when that
      // dependency moves, and one with no list at all re-runs every render, so neither
      // is the capture this claim is about — and flagging them would report every
      // ordinary effect in the tree.
      if (argumentTexts[1] === EMPTY_DEPENDENCY_LIST) {
        cells.push({ held: argumentTexts.slice(0, 1), dependencies: [] });
      }
    } else {
      cells.push({ held: argumentTexts, dependencies: [] });
    }
  }
  return cells;
}

/**
 * Which subject identifiers `source` captures in a state cell, or `[]`.
 *
 * An identifier named where the cell is PRODUCED and not where it is re-derived. A
 * memo that names the bridge in both re-derives when the bridge moves, which is the
 * correct shape and the one the palette's command list is written in; a cell that
 * names it only in the first is a value keyed on a subject it will never be produced
 * for again.
 */
export function capturedSubjectIdentifiers(source: string): readonly string[] {
  const captured = new Set<string>();
  for (const cell of stateCells(source)) {
    for (const identifier of SUBJECT_IDENTIFIERS) {
      const named = new RegExp(`\\b${identifier}\\b`);
      if (
        cell.held.some((text) => named.test(text)) &&
        !cell.dependencies.some((text) => named.test(text))
      ) {
        captured.add(identifier);
      }
    }
  }
  return [...captured].sort();
}
