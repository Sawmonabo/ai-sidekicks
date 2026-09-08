// What is on the renderer's initial import graph, pinned so an arrival is a red check.
//
// WHAT THIS ADDS TO THE BUDGET ROW BESIDE IT. `bundle-budget.test.ts` gates the SUM
// against `Spec-023 §Console Design (Meridian)` §Budgets, and a sum reports that the
// graph grew without reporting what grew it — so a family that arrives eagerly is
// invisible until it is expensive, and the diff that put it there is by then a hundred
// commits back. This census pins MEMBERSHIP: the chunks the entry graph carries, and
// every module inside them under the directory it belongs to. A registration written
// with `render` where it wanted a loader, a family door re-exporting a body only its own
// loader reads, a helper pulled the wrong way across a boundary — each of them lands a
// module in the committed pin, and the failure names it.
//
// TWO PINS AND NOT ONE. The chunk names answer "how many pieces does a launch fetch,
// and which", which is where a lost `manualChunks` grouping or a new eager entry shows
// up; the committed census answers "who is in them". Neither implies the other: the
// initial graph can gain a family without gaining a chunk, and it can gain a chunk while
// every family on it stays the same.
//
// AND THE CENSUS PIN IS MODULES AND NOT OWNER KEYS. A key set is blind to exactly the
// arrival it exists to catch once an owner is already on the list: a second module out of
// `console/browser/pane` — a directory the graph already holds for one registration
// module — moves no key, moves no chunk name, and can sit inside the byte budget next
// door. `initial-graph-pin.ts` holds the committed census, the shape it is written in,
// and the regeneration door; this file holds the cases that read it.
//
// IT IS A CENSUS AND NOT A BUDGET, so it pins no byte figure. Bytes have exactly one
// home — `budgets.json`, gated next door — and a threshold restated here would be the
// second home `apps/desktop/AGENTS.md §Config single-sourcing` rejects. What this file
// prints is the census itself, so the run that fails also carries the reading.
//
// AND IT NEVER SKIPS. The `console-bundle` Turbo task declares a `dependsOn: ["build"]`
// edge, so the subject is present by construction in CI and in `pnpm test`; a bare
// `vitest run` in a clean checkout fails here with the command that produces one,
// exactly as the budget gate beside it does.
//
// THE REFUSAL PATHS ARE NEXT DOOR. `initial-graph-census.refusals.test.ts` holds every case
// that plants a tree — no manifest, no source map beside a chunk, a malformed `sources` array
// — and the cleanup control over the trail they plant on. Nothing here plants anything and
// nothing there reads the build, which is why the two are separable at all.
//
// WHAT THIS LIST CANNOT BE MADE SHORTER BY, MEASURED RATHER THAN ASSUMED. The obvious
// lever on a graph this size is chunking — split the shared chunk so the entry carries
// only what the entry reaches. It buys nothing here, and the reason is measurable: a
// build with the module structure preserved, walked as the entry's own static closure,
// reaches every module the shared chunk holds bar none. There is no module riding a
// static chunk that only a lazy body reaches, so there is nothing for a grouping to
// move. Tree-shaking is not the lever either — the component library declares itself
// free of side effects and every import in this renderer names a per-component subpath
// rather than the package root, so nothing is being retained that could be dropped.
// What is left on the graph is there because eager code reaches it: the flagship
// surface's own row menus, the palette that is armed before anything is opened, the two
// overlays the root composes unconditionally, and the invite surface a deep link can
// arrive at. Shrinking this list further means making eager code reach less, which is a
// source change and never a bundler setting.
//
// IT READS THREE MODULES BECAUSE ITS SUBJECT IS THREE THINGS. `initial-graph-census.ts`
// reads the build; `initial-graph-owners.ts` says which owner a module belongs to and
// what it is called there; `initial-graph-pin.ts` holds the committed reading. The first
// split is `built-renderer-tree.ts`'s, one tier-mate along: a module that reads files of
// its own may hold no opinion about what counts as renderer source, and attributing a
// source-map path to a directory is exactly such an opinion. It also buys the
// attribution cases below their independence — they drive planted paths and need no
// build at all, while the census cases need one and read nothing else.

import process from "node:process";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_RENDERER_OUTPUT_DIRECTORY,
  RendererBundleOutputMissingError,
} from "../../../scripts/budget/measure-bundle.mjs";
import { readInitialGraphCensus } from "./initial-graph-census.js";
import { OWNER_PATH_SEGMENT_LIMIT, initialGraphAttributionOf } from "./initial-graph-owners.js";
import {
  INITIAL_GRAPH_PIN_PATH,
  INITIAL_GRAPH_PIN_REGENERATION_COMMAND,
  byCodeUnit,
  formatInitialGraphPinDelta,
  initialGraphPinOf,
  initialGraphPinRewriteRequested,
  readInitialGraphPin,
  writeInitialGraphPin,
  type InitialGraphPin,
} from "./initial-graph-pin.js";

/** An escape for censusing an out-of-tree build; NOT an escape from censusing. */
const rendererOutputDirectory: string =
  process.env["CONSOLE_BUDGET_RENDERER_OUT_DIR"] ?? DEFAULT_RENDERER_OUTPUT_DIRECTORY;

/**
 * The assets a launch fetches before it can paint, named without their content hashes.
 *
 * Five: the entry chunk and its stylesheet, `routing`, which the entry and every body
 * that reads an address both reach, `core`, hoisted out BECAUSE it is shared with lazy
 * bodies and therefore initial by construction, and `chunk` — rolldown's shared
 * CommonJS-interop runtime (`__commonJS` / `__toESM`), hoisted into a chunk of its own
 * once the lazy bodies shared it, imported by the entry, and holding no module at all
 * (the bundler's own table says so, and `MODULE_FREE_CHUNKS` below pins that reading).
 *
 * WHAT MOVES THIS LIST, AND WHAT MUST NOT. A chunk appearing here that names a view
 * family is the eager import this census exists to catch, and the check names the
 * module. The bundler's own split is the other way it moves: which shared modules get
 * hoisted into a chunk of their own is a function of what is shared, so a change that
 * takes a module off the graph can also collapse a split — this list lost a separate
 * `primitives` chunk and its sheet, and gained `core`, when the workflow definition
 * file codec moved its form module behind `import()`. That is a re-derivation and not
 * a regression, and it is why the total gzip figure the budget gate reads is the
 * measurement of record; this list is the membership.
 */
const INITIAL_GRAPH_CHUNKS: readonly string[] = [
  "chunk.js",
  "core.js",
  "index.css",
  "index.js",
  "routing.js",
];

/**
 * The initial chunks the bundler compiled out of no file — exactly one today.
 *
 * Pinned so a second one is a red check: a module-free chunk moves no module and no
 * byte worth a budget row, so it is invisible to every other reading here, and a change
 * in how the bundler splits its runtime is still a change somebody should look at.
 */
const MODULE_FREE_CHUNKS: readonly string[] = ["chunk.js"];

/**
 * A module in a directory the initial graph must not hold, for the negative controls.
 *
 * The terminal emulator: a pane body behind a loader, whose adapter is the largest lazy
 * chunk the build emits. If this ever appears on the initial graph the census is right
 * to fail, which is what makes it a fair planted input rather than a shape nothing
 * could ever produce.
 */
const OFF_GRAPH_MODULE = "../../../src/renderer/src/console/terminal/emulator/xterm-adapter.ts";

function censusOrFailLoudly(): ReturnType<typeof readInitialGraphCensus> {
  try {
    return readInitialGraphCensus(rendererOutputDirectory);
  } catch (censusError) {
    if (censusError instanceof RendererBundleOutputMissingError) {
      throw new Error(
        `${censusError.message}\nThis census fails rather than skips when its subject ` +
          "is missing: an empty reading is indistinguishable from a clean one.",
        { cause: censusError },
      );
    }
    throw censusError;
  }
}

describe("renderer initial-graph census", () => {
  const census = censusOrFailLoudly();
  const censusAsPin: InitialGraphPin = initialGraphPinOf(census.modulesByOwner);

  it("fetches exactly the chunks a launch is known to need", () => {
    expect(census.chunkNames).toStrictEqual(INITIAL_GRAPH_CHUNKS);
  });

  it("carries exactly the module-free chunks the build is known to emit", () => {
    expect(census.moduleFreeChunks).toStrictEqual(MODULE_FREE_CHUNKS);
  });

  it("holds exactly the modules this repository pinned, under exactly those owners", () => {
    console.log(formatCensus(census.modulesByOwner));
    if (initialGraphPinRewriteRequested(process.env)) {
      rewriteThePinAndSayWhatMoved(censusAsPin);
    }
    const pinned = readInitialGraphPin();
    expect(censusAsPin, formatInitialGraphPinDelta(pinned, censusAsPin)).toStrictEqual(pinned);
  });

  it("keys the census in code-unit order, so two runners pin one ordering", () => {
    // The pin is a sorted list, so this is what keeps the map it is derived FROM from
    // churning: a census that stopped sorting would still flatten to the same set, and
    // the reading printed above — which is per owner and in the map's own order — would
    // silently reorder on every runner. The ordering is asserted where it is produced.
    const owners = [...census.modulesByOwner.keys()];
    expect(owners).toStrictEqual([...owners].sort(byCodeUnit));
    for (const [owner, modules] of census.modulesByOwner) {
      expect([...modules], `\`${owner}\` lists its modules out of order`).toStrictEqual(
        [...modules].sort(byCodeUnit),
      );
    }
  });

  it("classifies every module it read, leaving none unattributed", () => {
    const unclassified = [...census.modulesByOwner.keys()].filter((owner) =>
      owner.startsWith("unclassified:"),
    );
    expect(
      unclassified,
      "a source shape the census does not recognise is a row nobody can read",
    ).toStrictEqual([]);
  });

  it("attributes every chunk it counted, and counts each module once", () => {
    const scriptCount = census.measurement.assets.filter((asset) =>
      asset.relativePath.endsWith(".js"),
    ).length;
    expect(scriptCount).toBeGreaterThan(0);
    // Over the owner-QUALIFIED names, because a module is named below its owner:
    // `index.js` is a file most packages have, and counting the bare names would report
    // a dozen duplicates that are a dozen different modules.
    expect(censusAsPin.length).toBeGreaterThan(0);
    expect(new Set(censusAsPin).size, "a module attributed twice").toBe(censusAsPin.length);
  });
});

describe("census attribution", () => {
  it("names the directory a module sits in, capped at its own segment limit", () => {
    expect(OWNER_PATH_SEGMENT_LIMIT).toBe(3);
    expect(
      initialGraphAttributionOf("../../../src/renderer/src/console/repos/mounts/roots/Root.tsx"),
    ).toStrictEqual({ owner: "console/repos/mounts", moduleId: "roots/Root.tsx" });
    expect(initialGraphAttributionOf("../../../src/renderer/src/App.tsx")).toStrictEqual({
      owner: "<renderer root>",
      moduleId: "App.tsx",
    });
    expect(initialGraphAttributionOf("../../../../src/shared/wire-errors.ts")).toStrictEqual({
      owner: "src/shared",
      moduleId: "wire-errors.ts",
    });
  });

  it("names an installed dependency by its own package, never by the store's directory", () => {
    // The module identity drops the store segment with it, which is the property that
    // makes the pin readable across a lockfile bump: a version and its peer hash live in
    // that segment, so pinning it would rewrite every dependency row whenever any of
    // them moved, whether or not the initial graph changed at all.
    expect(
      initialGraphAttributionOf(
        "../../node_modules/.pnpm/react-dom@19.2.6_react@19.2.6/node_modules/react-dom/cjs/x.js",
      ),
    ).toStrictEqual({ owner: "package:react-dom", moduleId: "cjs/x.js" });
    expect(
      initialGraphAttributionOf(
        "../../node_modules/.pnpm/@base-ui+react@1.7.0/node_modules/@base-ui/react/menu/M.mjs",
      ),
    ).toStrictEqual({ owner: "package:@base-ui/react", moduleId: "menu/M.mjs" });
    expect(initialGraphAttributionOf("../../../../packages/contracts/dist/event.js")).toStrictEqual(
      { owner: "workspace:contracts", moduleId: "dist/event.js" },
    );
  });

  it("negative control: a module off the initial graph is absent from the committed pin", () => {
    // The floor under the census pin. Asserting a map equals itself proves nothing about
    // whether the comparison could ever fail, so this drives the same classifier over a
    // module the graph does not hold and shows that neither its owner nor its identity is
    // in the pin — which is the exact difference the assertion above would report.
    const { owner, moduleId } = initialGraphAttributionOf(OFF_GRAPH_MODULE);
    expect(owner).toBe("console/terminal/emulator");
    expect(moduleId).toBe("xterm-adapter.ts");
    const pinned = readInitialGraphPin();
    expect(pinned).not.toContain(`${owner}/${moduleId}`);
    expect(pinned.some((entry) => entry.startsWith(`${owner}/`))).toBe(false);
  });

  it("negative control: an unrecognised source shape is named rather than dropped", () => {
    expect(initialGraphAttributionOf("virtual:some-plugin-module")).toStrictEqual({
      owner: "unclassified:virtual:some-plugin-module",
      moduleId: "virtual:some-plugin-module",
    });
  });
});

/**
 * Move the committed pin to what this build holds, and say what moved.
 *
 * The delta is read from the pin as it stood BEFORE the write, and a pin that could not
 * be read at all is reported as an empty census rather than as a throw: this is the one
 * path whose whole job is to produce the file the reader is missing.
 */
function rewriteThePinAndSayWhatMoved(census: InitialGraphPin): void {
  let previous: InitialGraphPin;
  try {
    previous = readInitialGraphPin();
  } catch {
    previous = [];
  }
  writeInitialGraphPin(census);
  console.warn(
    `Rewrote ${INITIAL_GRAPH_PIN_PATH}\n${formatInitialGraphPinDelta(previous, census)}`,
  );
}

/** The census as a reading, so the run that fails also carries what it read. */
function formatCensus(modulesByOwner: ReadonlyMap<string, readonly string[]>): string {
  const rows = [...modulesByOwner.entries()].map(
    ([owner, modules]) => `  ${String(modules.length).padStart(4)}  ${owner}`,
  );
  const moduleCount = [...modulesByOwner.values()].reduce((sum, held) => sum + held.length, 0);
  return [
    `Renderer initial-graph census — ${modulesByOwner.size} directories, ` +
      `${moduleCount} modules, pinned in ${INITIAL_GRAPH_PIN_PATH}`,
    ...rows,
    `Regenerate the pin with: ${INITIAL_GRAPH_PIN_REGENERATION_COMMAND}`,
  ].join("\n");
}
