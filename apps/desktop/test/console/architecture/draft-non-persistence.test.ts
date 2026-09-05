// The drafts tripwire: participant-authored text never reaches durable storage.
//
// `Spec-023 §Console Design (Meridian)` limits the UI-state store to layouts,
// selection, pins, and expansion state, and keeps composer drafts in window memory:
// a draft is participant-authored content, and a durable copy of it would need the
// encrypted, PII-mapped storage `Spec-022` specifies and the renderer does not have.
// Writing one to IndexedDB would put prose a person typed into an unencrypted
// origin-scoped database, outside every erasure selector the corpus defines.
//
// This is enforced in two independent ways, and the file asserts both because
// either alone would rot:
//
//   1. STRUCTURALLY — the durable path is reachable only through one write
//      chokepoint whose closed value-class enumeration has no draft, composer, or
//      form member, and whose identifier-shaped rule refuses prose by construction.
//      That is checked by CALLING it, not by reading it.
//   2. TEXTUALLY — no module under `persistence/` reaches a browser storage API
//      except the two named adapters, and the draft store reaches none at all. A
//      structural guard cannot see a `localStorage.setItem` someone adds beside it.
//
// Each has a negative control, because a guard that cannot fail is not a guard.

import { join } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

// Statically, not through `await import()` inside each case, which is what these
// three used to do. A dynamic import inside a case charges the module's whole
// transform-and-load cost — Vite resolving the console's persistence graph — to
// that case's `testTimeout`, and this tier declares none, so the bill landed
// against Vitest's 5000 ms default; on a loaded runner with six turbo tasks in
// flight that is a coin flip rather than a budget. A static import pays the same
// cost during file collection, which no per-test budget bounds, and it is what
// the two sibling suites in this tier that import console source already do
// (`scenario-wire-truth.test.ts`, `scenario-delivery-shape.test.ts`). Nothing
// about the assertions changes: the chokepoint is still CALLED, not read.
import {
  PERSISTED_VALUE_CLASSES,
  validatePersistedValue,
} from "../../../src/renderer/src/console/persistence/value-classes.js";

import {
  CONSOLE_DIRECTORY,
  consoleSourceModules,
  moduleNamed,
  readConsoleSourceModule,
} from "../console-source-modules.js";
import { forEachDescendant, parseSourceText } from "../typescript-source.js";

const PERSISTENCE_DIRECTORY = join(CONSOLE_DIRECTORY, "persistence");

/** The persistence subtree, through the tier's one walk. */
const PERSISTENCE_MODULES = consoleSourceModules({ roots: [PERSISTENCE_DIRECTORY] });

/**
 * The browser storage APIs a renderer can reach. `caches` and `openDatabase` are
 * listed even though nothing uses them, because the point of an enumeration is to
 * cover the doors nobody has opened yet.
 */
const DURABLE_STORAGE_APIS: readonly string[] = [
  "localStorage",
  "sessionStorage",
  "indexedDB",
  "openDatabase",
  "caches",
];

/**
 * The two modules allowed to name a storage API, and what each is.
 *
 * An allow-list rather than a rule about file names: "the adapters may" is a
 * decision, and a decision belongs somewhere a reviewer can see it change.
 */
const STORAGE_ADAPTER_FILES: readonly string[] = ["indexeddb-adapter.ts", "memory-adapter.ts"];

/** Words that name participant-authored text rather than UI state. */
const PARTICIPANT_CONTENT_WORDS: readonly string[] = ["draft", "composer", "form"];

function persistenceSourceFiles(): readonly string[] {
  return PERSISTENCE_MODULES.map((module) => module.relativePath);
}

function readPersistenceSource(file: string): string {
  return readConsoleSourceModule(
    moduleNamed(PERSISTENCE_MODULES, `console/persistence/${file}`, "a persistence module"),
  );
}

/** What a module writes as code, with its comments gone by construction. */
interface ModuleCode {
  /** Every identifier, property name, and literal string the module writes. */
  readonly written: readonly string[];
  /** How many `import` declarations it carries. */
  readonly importCount: number;
}

/**
 * Read a module as CODE, which is the only reading either sweep below wants.
 *
 * Comments in this subtree name the storage APIs constantly — explaining why the
 * draft store does NOT use them is most of `draft-store.ts`'s header — so a check
 * over raw text fires on the very prose that documents the rule. That used to be
 * answered by a hand-written stripper whose own doc comment admitted it did not
 * understand a string containing `//`, and called that the safe direction.
 *
 * IT IS NOT THE SAFE DIRECTION HERE. Over-stripping is what the crude reading risks,
 * and this file's negative control asserts a planted comment is GONE — so a stripper
 * that under-stripped would fail loudly while one that over-stripped would delete the
 * `localStorage.setItem` beside it and report the tree clean. The parser makes the
 * question structural: comments are trivia and belong to no node, so no stripper has
 * to be kept correct, and a string containing `//` is a string literal like any other.
 */
function readModuleCode(fileName: string, source: string): ModuleCode {
  const parsed = parseSourceText(fileName, source);
  const written: string[] = [];
  let importCount = 0;
  const consider = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      importCount += 1;
      return;
    }
    // Identifiers cover a bare `localStorage` and the `.localStorage` of a member
    // access alike; the literal arms cover the computed forms — `globalThis["caches"]`
    // and a name assembled in a template — which an identifier walk alone cannot see.
    if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) {
      written.push(node.text);
      return;
    }
    if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node)) {
      written.push(node.text);
      return;
    }
    if (ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      written.push(node.text);
    }
  };
  consider(parsed);
  forEachDescendant(parsed, consider);
  return { written, importCount };
}

/**
 * Whether the module writes any text containing `needle`, outside its comments.
 *
 * `includes` per written unit rather than an exact name match, which keeps the
 * reading this replaces exactly as strict as it was: `localStorageKey` counts, and
 * narrowing that to equality would be a second change hiding inside a mechanical one.
 */
function mentions(code: ModuleCode, needle: string): boolean {
  return code.written.some((text) => text.includes(needle));
}

describe("tripwire — the durable store admits no participant-authored text", () => {
  it("names no draft, composer, or form class in its closed enumeration", () => {
    for (const valueClass of PERSISTED_VALUE_CLASSES) {
      for (const word of PARTICIPANT_CONTENT_WORDS) {
        expect(valueClass.toLowerCase()).not.toContain(word);
      }
    }
  });

  it("refuses prose through the write chokepoint, whatever class is claimed", () => {
    // A real composer draft: sentences, punctuation, spaces. Every admissible
    // class is tried, so the guarantee is "no class takes this" rather than "the
    // one class I thought of does not".
    const draftText =
      "Can you rerun the migration against the staging database and tell me what the " +
      "row counts look like afterwards? I think the last pass dropped something.";
    for (const valueClass of PERSISTED_VALUE_CLASSES) {
      expect(validatePersistedValue(valueClass, draftText)).toBeDefined();
    }
  });

  it("negative control: the chokepoint accepts the UI state it exists for", () => {
    // Without this, a `validatePersistedValue` that refused EVERYTHING would pass
    // the case above while having stopped working entirely.
    expect(validatePersistedValue("scheme", "dark")).toBeUndefined();
    expect(
      validatePersistedValue("selection", { timeline: "session-01H8", runs: "session-01H9" }),
    ).toBeUndefined();
    expect(validatePersistedValue("expansion", ["session-01H8"])).toBeUndefined();
  });
});

describe("tripwire — only the named adapters reach browser storage", () => {
  it("keeps every storage call inside the two adapters", () => {
    const offenders: string[] = [];
    for (const file of persistenceSourceFiles()) {
      if (STORAGE_ADAPTER_FILES.includes(file)) {
        continue;
      }
      const code = readModuleCode(file, readPersistenceSource(file));
      for (const api of DURABLE_STORAGE_APIS) {
        if (mentions(code, api)) {
          offenders.push(`${file}: ${api}`);
        }
      }
    }
    expect(offenders).toStrictEqual([]);
  });

  it("keeps the draft store free of storage APIs and of the durable adapter", () => {
    // Stated separately from the sweep above, because this is the one the rule is
    // ABOUT: the draft store must not merely avoid `indexedDB` directly, it must
    // not hold an adapter that would reach it on the store's behalf.
    const code = readModuleCode("draft-store.ts", readPersistenceSource("draft-store.ts"));
    for (const api of DURABLE_STORAGE_APIS) {
      expect(mentions(code, api), api).toBe(false);
    }
    expect(mentions(code, "PersistenceAdapter")).toBe(false);
    expect(mentions(code, "UiStateStore")).toBe(false);
    // No import at all: a Map-backed class needs nothing from this subtree, and an
    // import appearing here is the first move of persisting a draft. Counted off the
    // declarations rather than matched against a line start, which read an `import`
    // inside a template literal as one and missed a declaration written over two
    // lines.
    expect(code.importCount).toBe(0);
  });

  it("negative control: the sweep sees a storage call when there is one", () => {
    // Runs the same predicate over a planted source, so a reading that saw through
    // the code — or a `DURABLE_STORAGE_APIS` that had been emptied — fails here
    // rather than reporting the tree clean.
    const planted = [
      "// localStorage is discussed in this comment and must not count.",
      "export function saveDraft(text: string): void {",
      '  localStorage.setItem("draft", text);',
      "}",
    ].join("\n");
    const code = readModuleCode("planted.ts", planted);
    expect(DURABLE_STORAGE_APIS.filter((api) => mentions(code, api))).toStrictEqual([
      "localStorage",
    ]);
    // And the comment on the first line is genuinely absent rather than counted
    // twice, which is what makes the reading load-bearing rather than cosmetic.
    expect(mentions(code, "must not count")).toBe(false);
  });

  it("negative control: a storage call the hand-written stripper deleted is still seen", () => {
    // Both shapes measured against the regular expressions this replaces, and both
    // silently DELETED a real storage call rather than merely leaving prose behind —
    // which is the direction the old reading's own doc comment claimed it could not
    // fail in. Neither spelling is a hypothetical: one is a URL, the other a glob.
    //
    //   1. `"https://…" + localStorage.getItem(k)` — the `//` inside the string
    //      matched the line-comment pattern, so the rest of the line went, taking
    //      `localStorage` with it. The module read clean.
    //   2. A `/*` inside one string and a `*/` inside another three lines later
    //      matched the block-comment pattern ACROSS them, collapsing three statements
    //      into one and deleting the `sessionStorage` between.
    const cutByLineComment =
      'export const docsUrl = "https://x.test/a" + localStorage.getItem("k");';
    const cutByBlockComment = [
      'export const head = "src/*.ts";',
      "export const store = sessionStorage;",
      'export const tail = "dist*/bundle.js";',
    ].join("\n");

    expect(
      DURABLE_STORAGE_APIS.filter((api) =>
        mentions(readModuleCode("url.ts", cutByLineComment), api),
      ),
    ).toStrictEqual(["localStorage"]);
    expect(
      DURABLE_STORAGE_APIS.filter((api) =>
        mentions(readModuleCode("glob.ts", cutByBlockComment), api),
      ),
    ).toStrictEqual(["sessionStorage"]);
  });

  it("negative control: an import declaration is counted however it is written", () => {
    // The line-anchored match this replaces read the word rather than the statement:
    // a declaration whose clause runs onto a second line still begins with `import`,
    // but one written after anything else on its line did not match, and the word
    // inside a string did.
    expect(readModuleCode("none.ts", 'export const note = "import nothing";\n').importCount).toBe(
      0,
    );
    expect(
      readModuleCode(
        "wrapped.ts",
        'import {\n  PersistenceAdapter,\n} from "./adapter.js";\nexport const x = 1;\n',
      ).importCount,
    ).toBe(1);
  });
});
