// What is on the renderer's initial import graph, pinned so an arrival is a red check.
//
// WHAT THIS ADDS TO THE BUDGET ROW BESIDE IT. `bundle-budget.test.ts` gates the SUM
// against `Spec-023 §Console Design (Meridian)` §Budgets, and a sum reports that the
// graph grew without reporting what grew it — so a family that arrives eagerly is
// invisible until it is expensive, and the diff that put it there is by then a hundred
// commits back. This census pins MEMBERSHIP: the chunks the entry graph carries, and
// the directory every module in them belongs to. A registration written with `render`
// where it wanted a loader, a family door re-exporting a body only its own loader
// reads, a helper pulled the wrong way across a boundary — each of them lands a
// directory in this list, and the failure names it.
//
// TWO PINS AND NOT ONE. The chunk names answer "how many pieces does a launch fetch,
// and which", which is where a lost `manualChunks` grouping or a new eager entry shows
// up; the owner set answers "who is in them". Neither implies the other: the initial
// graph can gain a family without gaining a chunk, and it can gain a chunk while every
// family on it stays the same.
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
// IT READS TWO MODULES BECAUSE ITS SUBJECT IS TWO THINGS. `initial-graph-census.ts`
// reads the build; `initial-graph-owners.ts` says which directory owns a module. The
// split is `built-renderer-tree.ts`'s, one tier-mate along: a module that reads files of
// its own may hold no opinion about what counts as renderer source, and attributing a
// source-map path to a directory is exactly such an opinion. It also buys the
// attribution cases below their independence — they drive planted paths and need no
// build at all, while the census cases need one and read nothing else.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_RENDERER_OUTPUT_DIRECTORY,
  RENDERER_MANIFEST_RELATIVE_PATH,
  RendererBundleOutputMissingError,
} from "../../../scripts/budget/measure-bundle.mjs";
import { readInitialGraphCensus } from "./initial-graph-census.js";
import { OWNER_PATH_SEGMENT_LIMIT, initialGraphOwnerOf } from "./initial-graph-owners.js";
import { TemporaryDirectoryTrail } from "../temporary-directory.js";

/** An escape for censusing an out-of-tree build; NOT an escape from censusing. */
const rendererOutputDirectory: string =
  process.env["CONSOLE_BUDGET_RENDERER_OUT_DIR"] ?? DEFAULT_RENDERER_OUTPUT_DIRECTORY;

/**
 * The assets a launch fetches before it can paint, named without their content hashes.
 *
 * Four: the entry chunk and its stylesheet, `routing`, which the entry and every body
 * that reads an address both reach, and `core`, hoisted out BECAUSE it is shared with
 * lazy bodies and therefore initial by construction.
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
const INITIAL_GRAPH_CHUNKS: readonly string[] = ["core.js", "index.css", "index.js", "routing.js"];

/**
 * Every directory with a module on the initial graph.
 *
 * READ AS A CENSUS AND NOT AS AN ALLOW-LIST. A row here is a statement that this
 * directory is on the graph today, not a licence for it to be — the diet's own findings
 * live in the lane report, and several rows below are named there as blocked rather
 * than as settled. What the pin buys is that the set cannot change in silence.
 *
 * A NEW ROW IS THE FINDING. If a diff adds one, the question to answer is the
 * registration question `apps/desktop/AGENTS.md §Import boundaries` states — is this
 * painted before a person acts? — and the answers are a loader-backed registration, a
 * door line deleted, or a row added here with the reason it belongs.
 */
const INITIAL_GRAPH_OWNERS: readonly string[] = [
  "<renderer root>",
  "console",
  "console/agents/agent-console",
  "console/approvals",
  "console/bridge",
  "console/bridge/approvals",
  "console/bridge/daemon",
  "console/bridge/driver-capabilities",
  "console/bridge/growth-operations",
  "console/bridge/growth-port",
  "console/bridge/growth-values",
  "console/bridge/presence",
  "console/bridge/queue",
  "console/bridge/quotas",
  "console/bridge/readings",
  "console/bridge/run-streams",
  "console/bridge/runtime-nodes",
  "console/bridge/scenario-runtime",
  "console/bridge/transport",
  "console/bridge/web-authn",
  "console/bridge/wire-shapes",
  "console/browser",
  "console/browser/pane",
  "console/collaboration",
  "console/collaboration/channels",
  "console/collaboration/invites",
  "console/collaboration/members",
  "console/core",
  "console/frame",
  "console/frame/shell-state",
  "console/inspector",
  "console/onboarding",
  "console/onboarding/provider-readiness",
  "console/onboarding/relay",
  "console/onboarding/steps",
  "console/palette",
  "console/panes",
  "console/persistence",
  "console/primitives",
  "console/primitives/overlay",
  "console/primitives/posture",
  "console/primitives/restore",
  "console/repos",
  "console/repos/artifact-pane",
  "console/repos/artifacts",
  "console/repos/attachments",
  "console/repos/diff-pane",
  "console/repos/mounts",
  "console/repos/proposals",
  "console/routing",
  "console/runs",
  "console/seats",
  "console/sessions",
  "console/sessions/acts",
  "console/sessions/durable-view",
  "console/sessions/invitations",
  "console/sessions/notifications",
  "console/sessions/rows",
  "console/settings",
  "console/sign-in",
  "console/store",
  "console/terminal",
  "console/tokens",
  "console/workflows",
  "console/workflows/channel-progress",
  "console/workflows/parks",
  "console/workflows/runs",
  "console/workspace/sidebar",
  "package:@atlaskit/pragmatic-drag-and-drop",
  "package:@babel/runtime",
  "package:@base-ui/react",
  "package:@base-ui/utils",
  "package:@floating-ui/core",
  "package:@floating-ui/dom",
  "package:@floating-ui/react-dom",
  "package:@floating-ui/utils",
  "package:@tanstack/react-virtual",
  "package:@tanstack/virtual-core",
  "package:bind-event-listener",
  "package:diff",
  "package:idb",
  "package:raf-schd",
  "package:react",
  "package:react-dom",
  "package:scheduler",
  "package:tinykeys",
  "package:use-sync-external-store",
  "package:zod",
  "package:zustand",
  "runtime-node-attach",
  "session-bootstrap",
  "shell",
  "shell/composer",
  "shell/composer/accessories",
  "shell/composer/chips",
  "shell/composer/commands",
  "shell/composer/router",
  "src/shared",
  "workspace:contracts",
];

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

/** Every fixture tree the refusal cases plant, removed after each of them. */
const plantedFixtures = new TemporaryDirectoryTrail();

afterEach(() => {
  plantedFixtures.removeAll();
});

/** A renderer out-dir holding exactly the manifest given, for the refusal paths. */
function outputDirectoryWithManifest(name: string, manifest: unknown): string {
  const directory = plantedFixtures.create(`console-census-${name}-`);
  const manifestPath = path.join(directory, ...RENDERER_MANIFEST_RELATIVE_PATH.split("/"));
  mkdirSync(path.dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, JSON.stringify(manifest), "utf8");
  return directory;
}

/** The chunk the manifest above names, so the measurer resolves and the census reads. */
function plantInitialChunk(directory: string): string {
  const chunkPath = path.join(directory, "assets", "index.js");
  mkdirSync(path.dirname(chunkPath), { recursive: true });
  writeFileSync(chunkPath, "export {};\n", "utf8");
  return chunkPath;
}

describe("renderer initial-graph census", () => {
  const census = censusOrFailLoudly();

  it("fetches exactly the chunks a launch is known to need", () => {
    expect(census.chunkNames).toStrictEqual(INITIAL_GRAPH_CHUNKS);
  });

  it("holds modules from exactly the directories this census records", () => {
    const owners = [...census.modulesByOwner.keys()];
    console.log(formatCensus(census.modulesByOwner));
    expect(
      owners,
      "The initial import graph gained or lost a directory. A NEW row is the finding: " +
        "ask the registration question — is this painted before a person acts? — and " +
        'answer it with `body: () => import("./<name>-body.js")`, with a deleted door ' +
        "line, or by adding the row here with the reason it belongs. A LOST row is a " +
        "diet that worked, and the pin moves with it.",
    ).toStrictEqual(INITIAL_GRAPH_OWNERS);
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
    const modules = [...census.modulesByOwner.values()].flat();
    expect(modules.length).toBeGreaterThan(0);
    expect(new Set(modules).size, "a module attributed twice").toBe(modules.length);
  });
});

describe("census attribution", () => {
  it("names the directory a module sits in, capped at its own segment limit", () => {
    expect(OWNER_PATH_SEGMENT_LIMIT).toBe(3);
    expect(
      initialGraphOwnerOf("../../../src/renderer/src/console/repos/mounts/roots/Root.tsx"),
    ).toBe("console/repos/mounts");
    expect(initialGraphOwnerOf("../../../src/renderer/src/App.tsx")).toBe("<renderer root>");
    expect(initialGraphOwnerOf("../../../../src/shared/wire-errors.ts")).toBe("src/shared");
  });

  it("names an installed dependency by its own package, never by the store's directory", () => {
    expect(
      initialGraphOwnerOf(
        "../../node_modules/.pnpm/react-dom@19.2.6_react@19.2.6/node_modules/react-dom/cjs/x.js",
      ),
    ).toBe("package:react-dom");
    expect(
      initialGraphOwnerOf(
        "../../node_modules/.pnpm/@base-ui+react@1.7.0/node_modules/@base-ui/react/menu/M.mjs",
      ),
    ).toBe("package:@base-ui/react");
    expect(initialGraphOwnerOf("../../../../packages/contracts/dist/event.js")).toBe(
      "workspace:contracts",
    );
  });

  it("negative control: a module off the initial graph classifies to a row nobody pinned", () => {
    // The floor under the owner pin. Asserting a set equals itself proves nothing about
    // whether the comparison could ever fail, so this drives the same classifier over a
    // module the graph does not hold and shows that its row is absent from the pin —
    // which is the exact difference the assertion above would report.
    const owner = initialGraphOwnerOf(OFF_GRAPH_MODULE);
    expect(owner).toBe("console/terminal/emulator");
    expect(INITIAL_GRAPH_OWNERS).not.toContain(owner);
  });

  it("negative control: an unrecognised source shape is named rather than dropped", () => {
    expect(initialGraphOwnerOf("virtual:some-plugin-module")).toBe(
      "unclassified:virtual:some-plugin-module",
    );
  });
});

describe("census refusals", () => {
  it("refuses a tree with no chunk manifest", () => {
    const directory = plantedFixtures.create("console-census-empty-");
    expect(() => readInitialGraphCensus(directory)).toThrow(RendererBundleOutputMissingError);
  });

  it("refuses an initial chunk with no source map beside it", () => {
    // The reading that would otherwise pass while describing nothing: the manifest
    // resolves, the chunk file is there, and the census reads no modules out of it.
    const directory = outputDirectoryWithManifest("no-map", {
      "index.html": { file: "assets/index.js", isEntry: true },
    });
    plantInitialChunk(directory);
    expect(() => readInitialGraphCensus(directory)).toThrow(/source map/u);
  });

  it("refuses a source map whose `sources` array holds a non-string member", () => {
    // The reading that would otherwise be short by one module, and green: the owner set
    // pins the directories that REMAIN and the non-empty checks are met by the other
    // chunks, so a dropped member takes a family off the graph in silence. A good member
    // either side of the bad one makes the drop the only difference.
    const directory = outputDirectoryWithManifest("malformed-sources", {
      "index.html": { file: "assets/index.js", isEntry: true },
    });
    const mapPath = `${plantInitialChunk(directory)}.map`;
    writeFileSync(mapPath, JSON.stringify({ version: 3, sources: ["a.ts", 7, "b.ts"] }), "utf8");
    expect(() => readInitialGraphCensus(directory)).toThrow(/at index 1 \(`number`\)/u);
  });
});

describe("census fixture cleanup", () => {
  // The floor under the `afterEach` above, and the only place a removal is observable:
  // AFTER the hook has run. The first case plants a tree and records where, the second
  // reads that path once the hook has had its turn — and without the hook it is still
  // there, which is the finding: every run of the refusal suite left one behind.
  let plantedForTheControl = "";

  it("plants a fixture tree the refusal cases above drive", () => {
    plantedForTheControl = outputDirectoryWithManifest("cleanup-control", {
      "index.html": { file: "assets/index.js", isEntry: true },
    });
    expect(existsSync(plantedForTheControl)).toBe(true);
    expect(plantedFixtures.plantedDirectories).toStrictEqual([plantedForTheControl]);
  });

  it("negative control: that tree is gone once the suite's hook has run", () => {
    expect(plantedForTheControl, "the case above did not run").not.toBe("");
    expect(
      existsSync(plantedForTheControl),
      "a census fixture outlived the test that planted it, so every local and CI run " +
        "leaves another tree behind under the system temporary directory",
    ).toBe(false);
    expect(plantedFixtures.plantedDirectories).toStrictEqual([]);
  });
});

/** The census as a reading, so the run that fails also carries what it read. */
function formatCensus(modulesByOwner: ReadonlyMap<string, readonly string[]>): string {
  const rows = [...modulesByOwner.entries()].map(
    ([owner, modules]) => `  ${String(modules.length).padStart(4)}  ${owner}`,
  );
  return [`Renderer initial-graph census — ${modulesByOwner.size} directories`, ...rows].join("\n");
}
