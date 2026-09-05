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

/**
 * Source with comments removed.
 *
 * Comments in this subtree name the storage APIs constantly — explaining why the
 * draft store does NOT use them is most of `draft-store.ts`'s header — so a check
 * over raw text would fire on the very prose that documents the rule. Stripping is
 * deliberately crude (it does not understand strings containing `//`), which is
 * the safe direction: it can only leave MORE text for the check to see.
 */
function withoutComments(source: string): string {
  return source.replaceAll(/\/\*[\s\S]*?\*\//g, "").replaceAll(/\/\/[^\n]*/g, "");
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
      const code = withoutComments(readPersistenceSource(file));
      for (const api of DURABLE_STORAGE_APIS) {
        if (code.includes(api)) {
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
    const code = withoutComments(readPersistenceSource("draft-store.ts"));
    for (const api of DURABLE_STORAGE_APIS) {
      expect(code).not.toContain(api);
    }
    expect(code).not.toContain("PersistenceAdapter");
    expect(code).not.toContain("UiStateStore");
    // No import at all: a Map-backed class needs nothing from this subtree, and an
    // import appearing here is the first move of persisting a draft.
    expect(code).not.toMatch(/^\s*import\s/mu);
  });

  it("negative control: the sweep sees a storage call when there is one", () => {
    // Runs the same predicate over a planted source, so a `withoutComments` that
    // over-stripped — or a `DURABLE_STORAGE_APIS` that had been emptied — fails
    // here rather than reporting the tree clean.
    const planted = [
      "// localStorage is discussed in this comment and must not count.",
      "export function saveDraft(text: string): void {",
      '  localStorage.setItem("draft", text);',
      "}",
    ].join("\n");
    const code = withoutComments(planted);
    const hits = DURABLE_STORAGE_APIS.filter((api) => code.includes(api));
    expect(hits).toStrictEqual(["localStorage"]);
    // And the comment on the first line is genuinely gone rather than counted
    // twice, which is what makes the stripping load-bearing rather than cosmetic.
    expect(code).not.toContain("must not count");
  });
});
