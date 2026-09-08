// A loader-backed body is not on the graph every launch pays for.
//
// WHAT THIS IS FOR. A registration written as `body: () => import("./x-body.js")` reads
// like a boundary and is not one on its own. The bundler assigns a module reachable BOTH
// statically and dynamically to the static chunk, so a dynamic import of something the
// entry graph already reaches resolves to the entry chunk and defers nothing — the
// registration looks deferred in the diff, and nothing in the tree disagrees out loud.
//
// THE DEFECT THIS WAS WRITTEN AGAINST. The sidekicks page left the agents family through
// that family's door, and `collaboration-family.ts` imports that door EAGERLY to register
// the agent console's surface. So the page and its stylesheet sat on the initial graph of
// every launch, including every launch that never opened settings.
//
// WHY THE GATES BESIDE IT DID NOT REPORT IT.
// `stylesheet-chunk-root-ownership.test.ts` asks whether any module a sheet's owning
// barrel reaches can USE the sheet. The door reached the page, the page names the sheet's
// classes, so the sheet had a user and was correctly placed — a true answer to the
// question that gate asks, which is whether a sheet is usable from where it enters and
// not whether a boundary defers anything. `barrel-census.test.ts` asks whether a door line
// has a production reader; that one did, and the reader was the registration itself. And
// neither could have caught the ORIGINAL state on any reading, because the page was
// registered with a `render` and there was no boundary to check. What this file pins is
// the FIX: the page is behind a loader now, and a re-added static path to it — a door
// line, a convenience re-export, a helper pulled the wrong way — puts it back on every
// launch, silently, and fails here instead.
//
// AND THE SAME DEFECT LANDED TWICE MORE, which is why this file holds three claims rather
// than one. `console/browser-settings-page.ts` mounted the bound section published by
// `browser/index.ts`, a door `console/panes/index.ts` imports eagerly for the browser
// pane's seat, so that page rode the entry chunk exactly as the sidekicks page had. And
// `ledger/index.ts` imported ONE component — the gap-fill banner it mounts above the
// session workspace — through `pane/replay/index.ts`, which put the replay engine and
// everything the engine reads on every launch beside it. Neither is a new rule: a door is
// an edge to every module it re-exports from, and both are the shape the first paragraph
// describes.
//
// WHY THE CLAIMS ARE SCOPED TO THESE SUBTREES AND NOT TO EVERY CHUNK ROOT. The general
// form — no chunk root shares a module of its own family with the eager graph — was
// written and MEASURED, and it reports twenty-one modules in `repos/`, every one of them
// legitimate: `repos/diff-pane/` holds an eagerly registered inline card
// (`InlineDiffCard`, reached through `repos/family-bodies.ts`) beside the lazily loaded
// diff pane, and the two share the diff renderer. A renderer an eager card mounts BELONGS
// in the entry chunk, so the general form's finding there is a true statement about the
// graph and a false statement about the defect. Nothing structural separates the two
// cases — one directory holding an eager body and a lazy one is a legal arrangement — so
// the claims are made about subtrees whose legitimate overlap can be NAMED rather than
// pinned as a list of exceptions that would have to be re-derived every time a component
// is added. Two of the three have no eager body at all and assert the empty set; the
// ledger's directory has exactly one, the banner its own root mounts, so that claim names
// the pair and reports a third module as a failure.
//
// EACH SUBTREE IS READ FROM ITS REGISTRATION, not written here. The loader specifier in
// `sidekicks-settings-page.ts`, in `browser-settings-page.ts`, and in `ledger/index.ts`
// names that body's chunk root; its directory is what must stay off the eager graph. So
// moving a body moves its claim with it, and deleting a loader fails the derivation rather
// than quietly asserting nothing.
//
// ROOTED AT THE COMPOSITION SITES, READ OFF THE TREE RATHER THAN LISTED HERE.
// `console-root-is-composition-only` in `.dependency-cruiser.mjs` fails any module directly
// under `console/` that imports into the console and is not enumerated in
// `COMPOSITION_ROOT_FILES`, so every root that can contribute to the eager graph is a
// module directly under `console/` — and the walk this tier already performs knows which
// those are. A hand-written copy of that enumeration was what this held first, and it went
// stale the moment a family landed a root registrar of its own: the copy still named three,
// the console held four, and the understated closure would have reported an empty finding
// as a clean tree. Reading the tree cannot go stale, and it is strictly the safer side of
// the difference — a root the enumeration has not admitted yet is one this walk follows
// anyway, while one it admits and this walk skipped is a hole.
//
// AND THE DERIVATION ITSELF NOW LIVES IN `stylesheet-static-reach.ts`, hoisted on its
// second reader rather than copied to it: `stylesheet-chunk-root-ownership.test.ts` asks
// the converse question — is anything ON the eager graph rendering against a sheet only a
// chunk carries — and two copies of one walk are how the two claims would come to disagree
// about which roots count while both stayed green.

import { posix, win32 } from "node:path";

import { describe, expect, it } from "vitest";

import { toPosixSeparators } from "../console-source-modules.js";
import { CONSOLE_STYLESHEET_TREE, resolveStylesheet } from "./stylesheet-edge-graph.js";
import { dynamicImportSpecifiers } from "./stylesheet-specifiers.js";
import { StylesheetReachIndex, eagerlyReachedModules } from "./stylesheet-static-reach.js";

/** The module that registers the sidekicks settings page, and holds its loader. */
const SIDEKICKS_PAGE_REGISTRATION = "sidekicks-settings-page.ts";

/** The module that registers the browser settings page, and holds its loader. */
const BROWSER_SETTINGS_PAGE_REGISTRATION = "browser-settings-page.ts";

/** The ledger family's door, which holds the timeline pane's loader. */
const LEDGER_FAMILY_DOOR = "ledger/index.ts";

/**
 * What the ledger's own chunk directory is still allowed to have on the eager graph.
 *
 * A PIN AND NOT AN EMPTY CLAIM, because `ledger/pane/` is the mixed case the header
 * describes: the family root mounts the gap-fill banner above the session workspace —
 * `ledger/index.ts` names `./pane/replay/LedgerGapFill.js` and that surface is eager by
 * design — while every other module under `pane/` belongs to the timeline body's chunk.
 * The banner and the hook it composes are the whole of the legitimate overlap, so naming
 * them is what makes a THIRD module a failure. The comparison is equality, so a module
 * that stops being reached without leaving this list fails too.
 *
 * It held five before the root stopped reaching `pane/replay/index.ts` for that one
 * component — the barrel, the reveal derivation and the replay engine beside these two —
 * and the list UNDERSTATES what that edge cost, because a prefix filter cannot see what
 * the engine went on to reach: `ledger/structure/` and `ledger/cards/` left the entry
 * chunk in the same change, measured on the built bundle rather than argued. A door is an
 * edge to every module it re-exports from, and the root names the declaring module
 * directly now, which is the form `apps/desktop/AGENTS.md` §Module shape already states
 * for a family door.
 */
const LEDGER_EAGER_PANE_MODULES: readonly string[] = [
  "ledger/pane/replay/LedgerGapFill.tsx",
  "ledger/pane/replay/ledger-gap-fill.ts",
];

/**
 * The directory a resolved tree path sits in, as a prefix a tree path starts with.
 *
 * DERIVED IN `path.posix` AND NOT IN THE HOST'S SEPARATOR. Tree paths carry `/` on every
 * host — `stylesheet-edge-graph.ts` mints them that way and its header says why — so the
 * derivation that splits one has to be the POSIX one whatever machine it runs on. Written
 * as a search for the last `/`, this answered the EMPTY STRING for a Windows-spelled path,
 * and the empty string is a prefix every module in the console starts with: the claim
 * below would have quantified over the whole tree rather than over one directory and
 * reported every eagerly reached module as a chunk-boundary offence.
 */
function chunkDirectoryOf(resolvedModulePath: string): string {
  return `${posix.dirname(resolvedModulePath)}${posix.sep}`;
}

/**
 * The directory a registration's chunk root lives in, read from its own loader.
 *
 * Throws rather than answering `undefined` when the registration carries no loader: that
 * is the state this file exists to reject, and a derivation that returned nothing would
 * turn the claims below into assertions about an empty set.
 *
 * ONE DERIVATION FOR EVERY REGISTRATION THIS FILE PINS, taken by parameter rather than
 * copied per page: three modules register a loader-backed body whose subtree this tier
 * quantifies over, and three copies of one walk are how the three claims would come to
 * disagree about what a chunk directory is while all of them stayed green.
 */
function chunkDirectoryFrom(registrationModulePath: string): string {
  const source = CONSOLE_STYLESHEET_TREE.read(registrationModulePath);
  const specifiers = dynamicImportSpecifiers(registrationModulePath, source);
  const [specifier] = specifiers;
  if (specifiers.length !== 1 || specifier === undefined) {
    throw new Error(
      `${registrationModulePath} must carry exactly one dynamic import — the body's chunk ` +
        `root — and carries ${String(specifiers.length)}. A registration that reaches its ` +
        "body statically puts that body on every launch's initial graph.",
    );
  }
  const resolved = resolveStylesheet(registrationModulePath, specifier);
  if (resolved === undefined) {
    throw new Error(`the loader specifier ${specifier} resolves to nothing in the console tree`);
  }
  return chunkDirectoryOf(resolved);
}

/** Every module under one chunk directory that the eager graph reaches, sorted. */
function eagerlyReachedUnder(chunkDirectory: string): readonly string[] {
  const index = new StylesheetReachIndex(CONSOLE_STYLESHEET_TREE);
  return [...eagerlyReachedModules(CONSOLE_STYLESHEET_TREE, index)]
    .filter((modulePath) => modulePath.startsWith(chunkDirectory))
    .sort();
}

describe("the sidekicks settings page", () => {
  it("has no module of its own reachable without crossing its loader", () => {
    const directory = chunkDirectoryFrom(SIDEKICKS_PAGE_REGISTRATION);
    expect(
      eagerlyReachedUnder(directory),
      `${directory} is behind a loader, so nothing in it may be on the initial graph. ` +
        "The usual cause is a family-door re-export: a door another family imports eagerly " +
        "carries every module it names into the entry chunk, whichever form the " +
        "registration takes.",
    ).toStrictEqual([]);
  });

  it("is absent from the eager graph while its family's door is on it", () => {
    // The floor under the claim above, and the negative control it needs: a reach index
    // that resolved nothing would report the empty set and read as a clean tree. The agents
    // door IS on the eager graph — `collaboration-family.ts` imports it to register the
    // agent console's surface — so the walk demonstrably reaches into that family, and the
    // page's absence is a fact about the page rather than about the walk.
    const index = new StylesheetReachIndex(CONSOLE_STYLESHEET_TREE);
    const eager = eagerlyReachedModules(CONSOLE_STYLESHEET_TREE, index);
    expect(eager.has("agents/index.ts")).toBe(true);
    expect(eager.has("agents/definitions/SidekickDefinitionsPage.tsx")).toBe(false);
  });

  it("negative control: the directory is derived in POSIX and not in the host's separator", () => {
    // The one arm no host running this tier can reach, driven rather than reasoned about.
    // `path.win32` mints the spelling a Windows walk hands the tree on any machine, so what
    // is exercised here is the tree boundary's own normalisation: without it `posix.dirname`
    // reads a backslash-separated path as having no directory at all, answers ".", and the
    // prefix filter above admits every module in the console.
    const windowsSpelling = win32.join("agents", "definitions", "SidekickDefinitionsPage.tsx");
    expect(windowsSpelling).not.toContain(posix.sep);
    expect(chunkDirectoryOf(toPosixSeparators(windowsSpelling))).toBe("agents/definitions/");
  });

  it("resolves its chunk root to a directory inside the agents family", () => {
    // What the derivation is worth is what it names. A specifier resolving to some other
    // subtree would make the claim above true about a directory nobody registers from,
    // which is the shape a moved page leaves behind.
    expect(chunkDirectoryFrom(SIDEKICKS_PAGE_REGISTRATION)).toBe("agents/definitions/");
  });
});

describe("the browser settings page", () => {
  it("has no module of its own reachable without crossing its loader", () => {
    const directory = chunkDirectoryFrom(BROWSER_SETTINGS_PAGE_REGISTRATION);
    expect(
      eagerlyReachedUnder(directory),
      `${directory} is behind a loader, so nothing in it may be on the initial graph. The ` +
        "cause this claim was written against is a family-door re-export: " +
        "`browser/index.ts` published the bound section for this registration to mount, and " +
        "`console/panes/index.ts` imports that door eagerly for the browser pane's seat — so " +
        "the page, its two reads, its partition table and its clear rounds rode the entry " +
        "chunk on every launch that never opened settings.",
    ).toStrictEqual([]);
  });

  it("resolves its chunk root to a directory inside the browser family", () => {
    // What the derivation is worth is what it names, on the sidekicks page's reasoning: a
    // specifier resolving elsewhere would make the claim above true about a directory
    // nobody registers from, which is the shape a moved page leaves behind.
    expect(chunkDirectoryFrom(BROWSER_SETTINGS_PAGE_REGISTRATION)).toBe("browser/settings/");
  });
});

describe("the ledger's timeline pane", () => {
  it("has nothing but the family root's own banner reachable without crossing its loader", () => {
    const directory = chunkDirectoryFrom(LEDGER_FAMILY_DOOR);
    expect(
      eagerlyReachedUnder(directory),
      `${directory} is behind a loader apart from the two modules the family root mounts ` +
        "above the session workspace. Anything else on this list arrived through a barrel: " +
        "a door is an edge to every module it re-exports from, so importing one component " +
        "through `pane/replay/index.ts` put the replay engine — and everything the engine " +
        "reads — on every launch's initial graph.",
    ).toStrictEqual(LEDGER_EAGER_PANE_MODULES);
  });

  it("resolves its chunk root to the pane directory inside the ledger family", () => {
    expect(chunkDirectoryFrom(LEDGER_FAMILY_DOOR)).toBe("ledger/pane/");
  });
});
