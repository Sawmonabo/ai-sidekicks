// A settings page's body is not on the graph every launch pays for.
//
// WHAT THIS IS FOR. A registration written as `body: () => import("./x-body.js")` reads
// like a boundary and is not one on its own. The bundler assigns a module reachable BOTH
// statically and dynamically to the static chunk, so a dynamic import of something the
// entry graph already reaches resolves to the entry chunk and defers nothing — the
// registration looks deferred in the diff, and nothing in the tree disagrees out loud.
//
// THE DEFECT THIS WAS WRITTEN AGAINST, TWICE OVER. The sidekicks page left the agents
// family through that family's door, and `collaboration-family.ts` imports that door
// EAGERLY to register the agent console's surface. The browser settings page left the
// browser family through ITS door, which `panes/index.ts` imports eagerly to claim the
// deck's `browser` kind. Both pages and both stylesheets therefore sat on the initial
// graph of every launch, including every launch that never opened settings — one defect
// with one shape, which is why the claim below is a TABLE rather than a second file.
//
// WHY THE GATES BESIDE IT DID NOT REPORT IT.
// `stylesheet-chunk-root-ownership.test.ts` asks whether any module a sheet's owning
// barrel reaches can USE the sheet. The door reached the page, the page names the sheet's
// classes, so the sheet had a user and was correctly placed — a true answer to the
// question that gate asks, which is whether a sheet is usable from where it enters and
// not whether a boundary defers anything. `barrel-census.test.ts` asks whether a door line
// has a production reader; that one did, and the reader was the registration itself. And
// neither could have caught the ORIGINAL state on any reading, because each page was
// registered with a `render` and there was no boundary to check. What this file pins is
// the FIX: the pages are behind loaders now, and a re-added static path to one — a door
// line, a convenience re-export, a helper pulled the wrong way — puts it back on every
// launch, silently, and fails here instead.
//
// WHY THE CLAIM IS SCOPED TO THESE SUBTREES AND NOT TO EVERY CHUNK ROOT. The general
// form — no chunk root shares a module of its own family with the eager graph — was
// written and MEASURED, and it reports twenty-one modules in `repos/`, every one of them
// legitimate: `repos/diff-pane/` holds an eagerly registered inline card (`InlineDiffCard`,
// reached through `repos/family-bodies.ts`) beside the lazily loaded diff pane, and the two
// share the diff renderer. A renderer an eager card mounts BELONGS in the entry chunk, so
// the general form's finding there is a true statement about the graph and a false
// statement about the defect. Nothing structural separates the two cases — one directory
// holding an eager body and a lazy one is a legal arrangement — so the claim is made about
// subtrees that have no eager body rather than pinned as a list of exceptions that would
// have to be re-derived every time a diff component is added.
//
// EACH SUBTREE IS READ FROM ITS REGISTRATION, not written here. The loader specifier in
// each console-root registration names the chunk root; its directory is what must stay off
// the eager graph. So moving a page moves the claim with it, and deleting a loader fails
// the derivation rather than quietly asserting nothing. The TABLE itself is closed against
// the tree by its own case below, so a third page registered through a loader is a red
// check naming the registration rather than a claim silently made about two of three.
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

/** One console-root registration that hands a settings board a loader-backed page. */
interface LoaderBackedSettingsPage {
  /** The registration module, directly under `console/`, that carries the loader. */
  readonly registration: string;
  /** Where its loader specifier must resolve, so a moved page is a red check. */
  readonly chunkDirectory: string;
  /** The family door the page's own family publishes, which IS on the eager graph. */
  readonly familyDoor: string;
  /** A module of the page itself, which must NOT be — the claim, stated per page. */
  readonly deferredModule: string;
}

/**
 * Every page whose body is deferred, and what each one's boundary is worth.
 *
 * A TABLE AND NOT TWO FILES, because both entries pin one claim about one defect shape:
 * a page reached through its family's eagerly imported door. The `familyDoor` column is
 * what keeps each row from passing for the wrong reason — a reach index that resolved
 * nothing would report every page absent from the eager graph and read as a clean tree.
 */
const LOADER_BACKED_SETTINGS_PAGES: readonly LoaderBackedSettingsPage[] = [
  {
    registration: "sidekicks-settings-page.ts",
    chunkDirectory: "agents/definitions/",
    familyDoor: "agents/index.ts",
    deferredModule: "agents/definitions/SidekickDefinitionsPage.tsx",
  },
  {
    registration: "browser-settings-page.ts",
    chunkDirectory: "browser/settings/",
    familyDoor: "browser/index.ts",
    deferredModule: "browser/settings/BrowserSettingsSection.tsx",
  },
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
 * The directory one page's chunk root lives in, read from that page's own loader.
 *
 * Throws rather than answering `undefined` when the registration carries no loader: that
 * is the state this file exists to reject, and a derivation that returned nothing would
 * turn the claims below into assertions about an empty set.
 */
function settingsPageChunkDirectory(registration: string): string {
  const source = CONSOLE_STYLESHEET_TREE.read(registration);
  const specifiers = dynamicImportSpecifiers(registration, source);
  const [specifier] = specifiers;
  if (specifiers.length !== 1 || specifier === undefined) {
    throw new Error(
      `${registration} must carry exactly one dynamic import — the settings page's chunk ` +
        `root — and carries ${String(specifiers.length)}. A registration that reaches its ` +
        "body statically puts the page on every launch's initial graph.",
    );
  }
  const resolved = resolveStylesheet(registration, specifier);
  if (resolved === undefined) {
    throw new Error(`the loader specifier ${specifier} resolves to nothing in the console tree`);
  }
  return chunkDirectoryOf(resolved);
}

/** Every module directly under `console/` that defers anything, read off the tree. */
function consoleRootModulesCarryingALoader(): readonly string[] {
  return CONSOLE_STYLESHEET_TREE.modulePaths
    .filter((modulePath) => !modulePath.includes(posix.sep))
    .filter(
      (modulePath) =>
        dynamicImportSpecifiers(modulePath, CONSOLE_STYLESHEET_TREE.read(modulePath)).length > 0,
    )
    .sort();
}

describe.each(LOADER_BACKED_SETTINGS_PAGES)(
  "the settings page registered by $registration",
  ({ registration, chunkDirectory, familyDoor, deferredModule }) => {
    it("has no module of its own reachable without crossing its loader", () => {
      const directory = settingsPageChunkDirectory(registration);
      const index = new StylesheetReachIndex(CONSOLE_STYLESHEET_TREE);
      const eagerlyReached = [...eagerlyReachedModules(CONSOLE_STYLESHEET_TREE, index)]
        .filter((modulePath) => modulePath.startsWith(directory))
        .sort();
      expect(
        eagerlyReached,
        `${directory} is behind a loader, so nothing in it may be on the initial graph. ` +
          "The usual cause is a family-door re-export: a door another family imports eagerly " +
          "carries every module it names into the entry chunk, whichever form the " +
          "registration takes.",
      ).toStrictEqual([]);
    });

    it("is absent from the eager graph while its family's door is on it", () => {
      // The floor under the claim above, and the negative control it needs: a reach index
      // that resolved nothing would report the empty set and read as a clean tree. Each
      // family's door IS on the eager graph — `collaboration-family.ts` imports the agents
      // door to register the agent console's surface, and `panes/index.ts` imports the
      // browser door to claim the deck's `browser` kind — so the walk demonstrably reaches
      // into that family, and the page's absence is a fact about the page rather than
      // about the walk.
      const index = new StylesheetReachIndex(CONSOLE_STYLESHEET_TREE);
      const eager = eagerlyReachedModules(CONSOLE_STYLESHEET_TREE, index);
      expect(eager.has(familyDoor)).toBe(true);
      expect(eager.has(deferredModule)).toBe(false);
    });

    it("resolves its chunk root to the directory that owns the page", () => {
      // What the derivation is worth is what it names. A specifier resolving to some other
      // subtree would make the claim above true about a directory nobody registers from,
      // which is the shape a moved page leaves behind.
      expect(settingsPageChunkDirectory(registration)).toBe(chunkDirectory);
    });
  },
);

describe("the loader-backed settings pages, as a set", () => {
  // THE CLOSURE, and what makes the table above a claim about the console rather than
  // about two rows somebody remembered to write. A third page registered through a loader
  // would otherwise land with no chunk-boundary claim at all and nothing would report it —
  // the failure mode this whole file exists to reject, one level up.
  it("is every console-root registration that defers anything", () => {
    expect(consoleRootModulesCarryingALoader()).toStrictEqual(
      LOADER_BACKED_SETTINGS_PAGES.map((page) => page.registration).sort(),
    );
  });

  it("negative control: the closure reads the tree rather than the table", () => {
    // Without this, the case above would pass over a derivation that returned the table's
    // own column. The console root holds modules — every composition site among them — and
    // the ones carrying a loader are a strict, non-empty subset of them.
    const rootModules = CONSOLE_STYLESHEET_TREE.modulePaths.filter(
      (modulePath) => !modulePath.includes(posix.sep),
    );
    expect(rootModules.length).toBeGreaterThan(LOADER_BACKED_SETTINGS_PAGES.length);
    expect(consoleRootModulesCarryingALoader().length).toBeGreaterThan(0);
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
});
