// A settings page's body is not on the graph every launch pays for.
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
// WHY THE CLAIM IS SCOPED TO THIS SUBTREE AND NOT TO EVERY CHUNK ROOT. The general form —
// no chunk root shares a module of its own family with the eager graph — was written and
// MEASURED, and it reports twenty-one modules in `repos/`, every one of them legitimate:
// `repos/diff-pane/` holds an eagerly registered inline card (`InlineDiffCard`, reached
// through `repos/family-bodies.ts`) beside the lazily loaded diff pane, and the two share
// the diff renderer. A renderer an eager card mounts BELONGS in the entry chunk, so the
// general form's finding there is a true statement about the graph and a false statement
// about the defect. Nothing structural separates the two cases — one directory holding an
// eager body and a lazy one is a legal arrangement — so the claim is made about a subtree
// that has no eager body rather than pinned as a list of exceptions that would have to be
// re-derived every time a diff component is added.
//
// THE SUBTREE IS READ FROM THE REGISTRATION, not written here. The loader specifier in
// `sidekicks-settings-page.ts` names the chunk root; its directory is what must stay off
// the eager graph. So moving the page moves the claim with it, and deleting the loader
// fails the derivation rather than quietly asserting nothing.
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
 * The directory the sidekicks page's chunk root lives in, read from its own loader.
 *
 * Throws rather than answering `undefined` when the registration carries no loader: that
 * is the state this file exists to reject, and a derivation that returned nothing would
 * turn the claim below into an assertion about an empty set.
 */
function sidekicksChunkDirectory(): string {
  const source = CONSOLE_STYLESHEET_TREE.read(SIDEKICKS_PAGE_REGISTRATION);
  const specifiers = dynamicImportSpecifiers(SIDEKICKS_PAGE_REGISTRATION, source);
  const [specifier] = specifiers;
  if (specifiers.length !== 1 || specifier === undefined) {
    throw new Error(
      `${SIDEKICKS_PAGE_REGISTRATION} must carry exactly one dynamic import — the settings ` +
        `page's chunk root — and carries ${String(specifiers.length)}. A registration that ` +
        "reaches its body statically puts the page on every launch's initial graph.",
    );
  }
  const resolved = resolveStylesheet(SIDEKICKS_PAGE_REGISTRATION, specifier);
  if (resolved === undefined) {
    throw new Error(`the loader specifier ${specifier} resolves to nothing in the console tree`);
  }
  return chunkDirectoryOf(resolved);
}

describe("the sidekicks settings page", () => {
  it("has no module of its own reachable without crossing its loader", () => {
    const directory = sidekicksChunkDirectory();
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
    expect(sidekicksChunkDirectory()).toBe("agents/definitions/");
  });
});
