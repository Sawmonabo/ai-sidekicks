// preflight.mjs's contracts with the world OUTSIDE its own module: what it may
// import, and where it duplicates a shared definition.
//
// Both properties below currently hold. That is precisely why they are pinned
// here: each was previously asserted only by a prose comment, and a comment
// cannot notice the commit that breaks it. Two of the repo's fence rules have
// already been corrected four times (PR #207 rounds 2-4) — the next correction
// landing in one copy and not the other is the failure this file exists to
// catch, not a hypothetical.
//
// Run via:
//   node --test --experimental-strip-types \
//     .claude/skills/plan-execution/scripts/__tests__/preflight-external-contracts.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import process from "node:process";
import { resolve, dirname, join, sep, basename } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { BLOCKQUOTE_PREFIX_RE } from "../preflight.mjs";
import { stripBlockquotePrefix } from "../../../../../tools/docs-corpus/lib/markdown-fences.ts";

const SCRIPTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PREFLIGHT = resolve(SCRIPTS_DIR, "preflight.mjs");
const REPO_ROOT = resolve(SCRIPTS_DIR, "../../../..");

// ---------------------------------------------------------------------------
// 1. Blockquote-prefix parity with the shared fence tracker
// ---------------------------------------------------------------------------

// preflight.mjs cannot import the shared module — it runs under bare `node`
// per SKILL.md Phase 0.2, and on Node 22.14 (the `package.json` engines
// minimum) loading a `.ts` source fails with ERR_UNKNOWN_FILE_EXTENSION. The
// duplication is forced. What is NOT forced is leaving the two copies
// unchecked.
//
// These named cases are for READABILITY — they say what the grammar means, in
// shapes a person can check by eye. They are no longer what enforces the
// parity: a hand-written list can only fail on a divergence somebody thought
// to write down, and measuring showed it missing one. Perturbing the shared
// pattern's trailing ` ?` to `[ \t]?` diverges on a tab directly after the last
// marker, no case here contains that, and all fourteen passed the wrong
// pattern — a control that proved nothing about the rule it names. The
// exhaustive comparison below is the enforcement; this list documents intent.
const BLOCKQUOTE_CASES = [
  "> ```md",
  ">> nested quote",
  ">>> three deep",
  ">no space after marker",
  ">   three spaces after marker",
  "   > three spaces before marker",
  "    > FOUR spaces — indented code, marker must NOT be stripped",
  "\t> tab before marker — indented code, must NOT be stripped",
  "> > space-separated levels",
  "plain content line",
  "",
  ">",
  "> ",
  "  >  ```ts",
];

test("blockquote-prefix strip is byte-identical to the shared tracker's", () => {
  for (const line of BLOCKQUOTE_CASES) {
    assert.equal(
      line.replace(BLOCKQUOTE_PREFIX_RE, ""),
      stripBlockquotePrefix(line),
      `divergence on ${JSON.stringify(line)} — preflight.mjs and markdown-fences.ts have drifted`,
    );
  }
});

// The alphabet the prefix grammar is written over: the marker itself, both
// indent characters (spaces are budgeted, a tab is not), a fence character so a
// stripped result is something the tracker would go on to classify, and one
// ordinary letter to terminate a prefix. No character outside this set can
// change how a blockquote prefix parses.
const PREFIX_ALPHABET = [" ", "\t", ">", "`", "a"];

// Enumerating every string over that alphabet up to this length. Seven covers
// any string holding two full levels (`   >` is four characters) plus a
// trailing character, which is where a per-level, repetition, or trailing-space
// divergence has room to appear.
//
// Read this as MEASURED COVERAGE, not proof: it is exhaustive over this
// alphabet up to this bound, not over all strings. What it demonstrably does is
// separate both perturbations below, which the named list could not.
const PREFIX_BOUND = 7;

/**
 * Every string over `alphabet` up to `maxLength` characters, shortest first.
 *
 * @param {string[]} alphabet
 * @param {number} maxLength
 * @returns {Generator<string>}
 */
function* stringsOverAlphabet(alphabet, maxLength) {
  const buffer = [];
  function* extend() {
    yield buffer.join("");
    if (buffer.length === maxLength) return;
    for (const character of alphabet) {
      buffer.push(character);
      yield* extend();
      buffer.pop();
    }
  }
  yield* extend();
}

/**
 * Compare a candidate prefix pattern against the shared tracker's strip over
 * the whole enumeration.
 *
 * @param {RegExp} pattern
 * @returns {{ divergent: string[], checked: number }}
 */
function prefixParity(pattern) {
  const divergent = [];
  let checked = 0;
  for (const line of stringsOverAlphabet(PREFIX_ALPHABET, PREFIX_BOUND)) {
    checked++;
    if (line.replace(pattern, "") !== stripBlockquotePrefix(line)) divergent.push(line);
  }
  return { divergent, checked };
}

test("blockquote-prefix strip is byte-identical to the shared tracker's, exhaustively", () => {
  const { divergent, checked } = prefixParity(BLOCKQUOTE_PREFIX_RE);
  assert.deepEqual(
    divergent.slice(0, 8).map((line) => JSON.stringify(line)),
    [],
    `preflight.mjs and markdown-fences.ts have drifted on ${divergent.length} of ${checked} inputs`,
  );
  // Closed form for sum(alphabet^k, k=0..BOUND). Pinned so a generator that
  // stopped early cannot report a clean sweep over almost nothing — the same
  // empty-input vacuity this suite exists to prevent elsewhere.
  assert.equal(
    checked,
    (PREFIX_ALPHABET.length ** (PREFIX_BOUND + 1) - 1) / (PREFIX_ALPHABET.length - 1),
  );
});

test("control: the parity check can FAIL — both perturbed patterns are caught", () => {
  // Without this, a comparison of two identical no-op regexes would pass
  // forever and prove nothing.

  // `\s*` is the naive indent form CommonMark rejects: it lets a tab or a
  // fourth space stand in for the three-space marker budget.
  const naiveIndent = prefixParity(/^(?:\s*>)+ ?/);
  assert.ok(
    naiveIndent.divergent.length > 0,
    "the enumeration cannot distinguish a naive indent budget",
  );

  // `[ \t]?` is the drift the named list missed entirely, and the reason this
  // control moved off it: it differs from ` ?` on exactly one shape, a TAB
  // directly after the last marker, and the whole named list passed it.
  const tabAfterMarker = prefixParity(/^(?: {0,3}>)+[ \t]?/);
  assert.ok(
    tabAfterMarker.divergent.length > 0,
    "the enumeration cannot distinguish the trailing `[ \\t]?` drift",
  );
  // Every separating input is the predicted shape, so the control is failing
  // for the stated reason rather than for some unrelated accident.
  assert.deepEqual(
    tabAfterMarker.divergent.filter((line) => !/^(?: {0,3}>)+\t/.test(line)),
    [],
    "a separating input did not carry a tab directly after the marker run",
  );
});

// ---------------------------------------------------------------------------
// 2. The production graph takes no third-party dependency
// ---------------------------------------------------------------------------

// SKILL.md Phase 0.2 invokes `node .claude/…/preflight.mjs` — bare, with no
// `pnpm exec` and no install step anywhere ahead of it. A single third-party
// import anywhere in the reachable graph breaks that invocation in any tree
// where `node_modules` is absent, which includes every fresh worktree.
//
// The graph is enumerated by NODE ITSELF: a child process registers a resolve
// hook, imports preflight.mjs, and records every specifier the runtime actually
// resolved. The previous revision scanned the source with regexes after
// stripping comments, and that one mechanism drew three separate review
// findings. The root defect: a comment marker inside a string literal
// (`const a = "/*"; import z from "zod"; const b = "*/";`) deletes the code
// between the markers, so a real third-party import disappears before the scan
// ever sees it — a false clean in the gate whose whole purpose is catching that
// import. Making a hand-rolled scanner safe here is not cheap either, because
// preflight.mjs contains regex literals that themselves contain quote
// characters (`/^"[^"]*"$|^'[^']*'$/` at preflight.mjs § argument unquoting),
// which is exactly the input that defeats a string-aware scanner that is not
// also regex-aware. Asking the runtime removes the class instead of patching
// instances of it, and it answers the question the contract actually asks:
// what does `node` load?
//
// Import side effects are not a hazard here: preflight.mjs runs `main()` only
// under its `isDirectlyInvoked()` guard, so importing it resolves the graph and
// stops.

// TypeScript source extensions bare node refuses at the engines floor. `.d.ts`
// is covered by the `.ts` entry; `.tsx` is listed because a future file could
// carry it and the assertion should not have to be revisited to notice.
const TYPESCRIPT_EXTENSIONS = [".ts", ".mts", ".cts", ".tsx"];

// Runtime-resolved import forms. A resolve hook cannot see these — they resolve
// when the line executes, not when the module loads — so they stay a source
// scan, and the scan runs on RAW source with no comment stripping. That is
// deliberate: every module in the production graph currently contains zero
// matches even counting comments, so the strict form costs nothing today and
// fails CLOSED tomorrow. A commented-out `await import()` tripping this gate is
// a loud, correct-direction failure; a live one slipping through because a
// stripper mis-parsed the file around it is the failure this file exists to
// prevent.
//
// Every widening below only ADDS matches, so the fail-closed direction is
// preserved and prose like `import (something)` inside a comment now trips the
// gate. That is the intended strict direction and it costs nothing today —
// measured against the real graph, not assumed: the live match count is still
// zero, which the assertion in the scan test is what actually enforces.
//
// What may sit between a callee and its `(`. JS permits comments there —
// `import /* optional */ ("pkg")` is a valid dynamic import — and `\s*` cannot
// span a comment, so the narrower pattern missed that call entirely. The
// evasion was total rather than partial: a dynamic import inside a function
// that is never invoked at load time is also invisible to the resolve hook,
// because the call never executes, so BOTH layers reported clean.
const CALLEE_GAP = String.raw`(?:\s|/\*[\s\S]*?\*/|//[^\n]*\n)*`;

// `import.meta` is ALLOWLISTED rather than blocklisted, because it is a
// resolution CAPABILITY rather than a call.
//
// `import.meta.resolve("micromark")` returns a URL without importing anything,
// so no hook fires; deferred inside a function nobody invokes at load time, the
// graph walk reports a clean dependency-free tree while preflight throws
// ERR_MODULE_NOT_FOUND on the line that finally runs it — in precisely the
// fresh worktree this contract exists to protect.
//
// A fourth named CALL pattern would not have closed that. `import.meta.resolve(`
// is evaded by aliasing the method (`const resolveSpecifier =
// import.meta.resolve;` — no parenthesis at the access site), by computed
// access (`import.meta["resolve"]`), and by passing the whole object elsewhere
// and reaching through it there. Enumerating the spellings of a capability is
// the mechanism this file has now been burned by three times; naming the one
// LEGAL continuation and rejecting every other is bounded by construction, and
// an evasion has to become legal code to get through.
//
// `.url` is that continuation because it RESOLVES NOTHING — it reports where
// the module already is. That, not the census below, is why it is the legal
// one.
//
// Separately, and only as a statement of what the arm costs today: the graph
// uses `import.meta` twice, both `.url` (preflight.mjs § __dirname and
// § isDirectlyInvoked), none in lib/manifest.mjs — measured, not assumed. So
// the arm matches nothing now.
//
// The allowlist is therefore expected to GROW. A legitimate later use of a
// property that also resolves nothing — `import.meta.dirname`, say — will fail
// this arm, and the correct response is to add it here, not to loosen the
// pattern. Failing closed on an unrecognised capability is the behaviour being
// bought; the entry above just records which one is currently spent.
//
// Gaps are admitted on both sides of each token because `import . meta . url`
// is the same MetaProperty to the parser.
const IMPORT_META = String.raw`\bimport${CALLEE_GAP}\.${CALLEE_GAP}meta\b`;
const ALLOWED_IMPORT_META_PROPERTY = String.raw`${CALLEE_GAP}\.${CALLEE_GAP}url\b`;

const DYNAMIC_LOAD_FORMS = [
  ["dynamic import()", new RegExp(String.raw`\bimport${CALLEE_GAP}\(`)],
  // A bare-word match — no parenthesis, so no gap to span.
  ["createRequire", /\bcreateRequire\b/],
  ["require()", new RegExp(String.raw`\brequire${CALLEE_GAP}\(`)],
  // Named for what was SEEN rather than for the spelling that motivated it: the
  // failure should report that a non-`.url` `import.meta` use is present, in
  // whatever form, since the arm exists precisely because the forms are open.
  ["import.meta (non-url)", new RegExp(`${IMPORT_META}(?!${ALLOWED_IMPORT_META_PROPERTY})`)],
];

/** @param {string} source @returns {string[]} banned runtime-resolved forms present */
export function dynamicLoadForms(source) {
  return DYNAMIC_LOAD_FORMS.filter(([, pattern]) => pattern.test(source)).map(([name]) => name);
}

// Logged in a `finally` so that a specifier which FAILS to resolve is still
// reported. That is not an edge case — it is the primary one: in the fresh
// worktree this contract is about, an added third-party import does not
// resolve, and a hook that logged only successful resolutions would stay
// silent on precisely the commit it exists to catch. (Measured: the
// log-after-resolve form omits an uninstalled package entirely.)
//
// Imports made by the bootstrap module itself are skipped, so the log contains
// the graph's own edges and not the harness's.
// The LOAD hook is what answers "is this module CommonJS?", and it is the only
// thing that can. Measured on Node 22.12, all three of these disagree:
//
//   resolve hook, `.cjs`  -> format "commonjs"
//   resolve hook, `.js`   -> format ABSENT, though the module is CommonJS
//   load hook,    `.js`   -> format "commonjs"
//
// So a resolve-time format check reports clean on a plain `.js` CommonJS
// module, and an extension check never sees it either — `.js` is CommonJS or
// ESM depending on the nearest `package.json` `type`, which is a fact about a
// file the graph walk never reads. Node must settle the question to execute the
// module at all, so the load hook is asked instead of re-deriving it.
const MODULE_HOOKS_SOURCE = `import { appendFileSync } from "node:fs";

let logPath;
let loadLogPath;
let bootstrapURL;

export function initialize(data) {
  logPath = data.logPath;
  loadLogPath = data.loadLogPath;
  bootstrapURL = data.bootstrapURL;
}

export async function resolve(specifier, context, nextResolve) {
  let resolved = null;
  try {
    resolved = await nextResolve(specifier, context);
    return resolved;
  } finally {
    if (context.parentURL !== bootstrapURL) {
      appendFileSync(
        logPath,
        JSON.stringify({
          specifier,
          parentURL: context.parentURL ?? null,
          url: resolved === null ? null : resolved.url,
        }) + "\\n",
      );
    }
  }
}

export async function load(url, context, nextLoad) {
  let loaded = null;
  try {
    loaded = await nextLoad(url, context);
    return loaded;
  } finally {
    appendFileSync(
      loadLogPath,
      JSON.stringify({ url, format: loaded === null ? null : loaded.format }) + "\\n",
    );
  }
}
`;

const BOOTSTRAP_SOURCE = `import { register } from "node:module";
import { pathToFileURL } from "node:url";

const [entry, logPath, loadLogPath] = process.argv.slice(2);
register("./module-hooks.mjs", {
  parentURL: import.meta.url,
  data: { logPath, loadLogPath, bootstrapURL: import.meta.url },
});
await import(pathToFileURL(entry).href);
`;

/**
 * Enumerate a module graph the way node itself does.
 *
 * @param {string} entry absolute path to the entry module
 * @returns {{ ok: boolean, stderr: string, files: string[],
 *             records: Array<{ specifier: string, parentURL: string | null, url: string | null }>,
 *             loaded: Array<{ url: string, format: string | null }> }}
 */
function enumerateGraph(entry) {
  const directory = mkdtempSync(join(tmpdir(), "preflight-graph-"));
  try {
    const logPath = join(directory, "graph.jsonl");
    const loadLogPath = join(directory, "loads.jsonl");
    const bootstrap = join(directory, "bootstrap.mjs");
    writeFileSync(join(directory, "module-hooks.mjs"), MODULE_HOOKS_SOURCE);
    writeFileSync(bootstrap, BOOTSTRAP_SOURCE);
    writeFileSync(logPath, "");
    writeFileSync(loadLogPath, "");

    // What this child is NOT: a Node 22.12 runtime. It executes on whatever
    // binary runs this suite, and the flags below do not downgrade it. An API
    // that exists in Node 24 and not at the engines floor — a `node:module`
    // addition, say — is available to the graph here and would load happily,
    // so this child cannot answer whether the graph runs at the floor.
    //
    // FLOOR AUTHORITY IS CI, and it already covers this test. The `test-node22`
    // job in `.github/workflows/ci.yml` pins `node: ["22.14"]`, surfacing as the
    // check `test (ubuntu-latest / node 22.14)`, and its "Run
    // plan-execution skill tests (Layer 1 + Layer 2)" step runs this file. The
    // graph is therefore enumerated by an actual engines-floor binary on every
    // PR, which is what catches an API-availability divergence.
    //
    // What the two mechanisms below do is narrower, and local: they stop the
    // TypeScript assertions from going VACUOUS when the suite runs on a newer
    // runtime, so a developer's node 24 cannot report a clean pass that CI
    // would not have given. The relationship between them was measured rather
    // than assumed:
    //
    //   - `--no-experimental-strip-types` pins type-stripping OFF. Node 22.18+
    //     strips by default, so on a newer runtime this is the ONLY thing
    //     keeping the `.ts` assertion below from going vacuous — passing while
    //     proving nothing, the exact class this suite belongs to. (If a future
    //     node drops the flag it exits on the unknown option, so every test
    //     here fails loudly rather than silently relaxing.)
    //   - NODE_OPTIONS is scrubbed, which keeps the child hermetic against any
    //     flag the parent happens to carry — this suite itself runs under
    //     `--experimental-strip-types`.
    //
    // Against the NODE_OPTIONS vector specifically the two are REDUNDANT: a CLI
    // flag overrides NODE_OPTIONS, so removing either one alone still refuses
    // the `.ts` fixture and only removing both makes the control fail. Neither
    // is therefore individually pinned by a mutation, and neither is dead —
    // the flag is what survives a Node upgrade past 22.18, where there is no
    // environment variable left to scrub.
    const childEnvironment = { ...process.env };
    delete childEnvironment.NODE_OPTIONS;

    const child = spawnSync(
      process.execPath,
      ["--no-experimental-strip-types", bootstrap, entry, logPath, loadLogPath],
      { encoding: "utf8", env: childEnvironment },
    );

    const readLog = (path) =>
      readFileSync(path, "utf8")
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line));

    const records = readLog(logPath);
    const loaded = readLog(loadLogPath);

    // The entry is seeded explicitly: nothing imports it, so it never appears
    // as a resolved target, and a source scan over resolved targets alone would
    // skip the very file this suite is about.
    const files = [
      entry,
      ...records
        .filter((record) => record.url !== null && record.url.startsWith("file:"))
        .map((record) => fileURLToPath(record.url)),
    ];

    return {
      ok: child.status === 0,
      stderr: child.stderr ?? "",
      files: [...new Set(files)],
      records,
      loaded,
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("the preflight production graph imports only node: builtins and relatives", () => {
  const { ok, stderr, records } = enumerateGraph(PREFLIGHT);
  assert.ok(ok, `bare node could not load the preflight graph:\n${stderr}`);
  // A count alone would pass against a graph that never left the entry file.
  // Naming a module reachable ONLY through a relative specifier proves the
  // traversal edge is live; the set is deliberately not pinned as exhaustive,
  // so a legitimately-added module is discovered rather than rejected.
  assert.ok(
    records.some((record) => record.url !== null && record.url.endsWith("/lib/manifest.mjs")),
    `no relative import resolved — reached only: ${records.map((r) => r.specifier).join(", ")}`,
  );
  for (const { specifier, parentURL } of records) {
    const allowed =
      specifier.startsWith("node:") || specifier.startsWith("./") || specifier.startsWith("../");
    assert.ok(
      allowed,
      `${parentURL} imports "${specifier}" — the preflight graph must stay dependency-free (SKILL.md Phase 0.2 runs it under bare node, before any install)`,
    );
  }
});

/**
 * Containment violations among resolved targets, as human-readable strings.
 *
 * The root is a parameter rather than a constant so the controls can point it
 * at a fixture directory. Without that, a fixture in `tmpdir()` would trip the
 * escaped-the-root arm on its way to demonstrating the node_modules arm, and
 * neither control would pin the rule it names.
 *
 * @param {Array<{ specifier: string, parentURL: string | null, url: string | null }>} records
 * @param {string} root
 * @returns {string[]}
 */
function containmentViolations(records, root) {
  const violations = [];
  for (const { specifier, parentURL, url } of records) {
    // Builtins resolve to `node:fs` and have no path to contain.
    if (url === null || !url.startsWith("file:")) continue;
    const target = fileURLToPath(url);
    if (!target.startsWith(root + sep)) {
      violations.push(`${parentURL} imports "${specifier}", which resolves outside ${root}`);
    } else if (target.split(sep).includes("node_modules")) {
      // Segment-wise: a directory legitimately named `node_modules_notes` must
      // not trip this, and `node_modules` at any depth must.
      violations.push(
        `${parentURL} imports "${specifier}", which resolves into node_modules (${target}) — unavailable in a fresh worktree, where SKILL.md Phase 0.2 runs`,
      );
    }
  }
  return violations;
}

test("every module the preflight graph resolves stays in-repo and outside node_modules", () => {
  // A relative specifier satisfies the allowlist above and can still leave the
  // repo — `../../node_modules/pkg/index.js` is relative, resolves fine in a
  // tree that has been installed, and breaks the fresh-worktree contract the
  // moment `node_modules` is absent. The allowlist screens the SPELLING; this
  // screens where the spelling actually lands.
  const { ok, stderr, records } = enumerateGraph(PREFLIGHT);
  assert.ok(ok, `bare node could not load the preflight graph:\n${stderr}`);
  assert.deepEqual(containmentViolations(records, REPO_ROOT), []);
});

test("the preflight production graph loads under bare node, so no TypeScript source is reachable", () => {
  // The primary assertion is the load itself: at the engines floor, bare node
  // fails ERR_UNKNOWN_FILE_EXTENSION on any TypeScript source, so a graph that
  // imports one cannot start. This is the SKILL.md Phase 0.2 contract directly
  // rather than a proxy for it.
  //
  // The shared fence tracker is a `.ts` module, so this is the guard that stops
  // "just import the canonical one" from being applied to production — the same
  // reason the blockquote duplication above is forced. It ENCODES that
  // constraint; it does not resolve the duplication, which is Tier-2 work.
  const { ok, stderr, records } = enumerateGraph(PREFLIGHT);
  assert.ok(
    ok,
    `bare node could not load the preflight graph — a TypeScript source in the graph fails ERR_UNKNOWN_FILE_EXTENSION at the Node 22.12 floor:\n${stderr}`,
  );
  // Named separately so the failure says WHICH import is the problem. The load
  // check above proves the contract; this one makes the diagnosis one line
  // instead of a stack trace, and covers `.mts`/`.cts`/`.tsx` explicitly.
  //
  // Read it as a diagnostic, not as a second independent check: it is
  // UNFALSIFIABLE against the real graph by construction. A TypeScript source
  // in the graph stops the child from starting, so `ok` is already false and
  // this loop never runs on the case it describes. No control pins it, and
  // none can without a fixture whose load succeeds — which is the thing the
  // contract forbids.
  for (const { specifier, parentURL, url } of records) {
    const target = url ?? specifier;
    for (const extension of TYPESCRIPT_EXTENSIONS) {
      assert.ok(
        !target.endsWith(extension),
        `${parentURL} imports "${specifier}" — bare node cannot load a TypeScript source (ERR_UNKNOWN_FILE_EXTENSION)`,
      );
    }
  }
});

/**
 * CommonJS modules among a loaded set, by URL.
 *
 * Named and shared with the controls below on purpose. An assertion that
 * filtered inline would leave the controls proving only what NODE reports,
 * pinning nothing about what the assertion keys ON — so swapping this test for
 * a `.cjs` extension check would break no control while silently reverting the
 * property. Routing both through one function is what makes that mutation
 * visible.
 *
 * @param {Array<{ url: string, format: string | null }>} loaded
 * @returns {string[]}
 */
function commonjsModules(loaded) {
  return loaded.filter((module) => module.format === "commonjs").map((module) => module.url);
}

test("no module in the preflight production graph loads as CommonJS", () => {
  // The structural half of the runtime-resolved ban below. `require` is a
  // binding only a CommonJS module has; in ESM it does not exist, so an alias
  // (`const load = require; load("micromark")`) cannot be written at all — and
  // `createRequire`, the single route from ESM to a `require`, is already banned
  // as a bare word. An all-ESM graph therefore closes the aliasing evasion by
  // construction, which no token pattern can: a scan chasing `require` through
  // arbitrary renamings is chasing an unbounded set, and every pattern added to
  // it is one more thing to evade.
  //
  // "All-ESM" is ASSERTED here, not assumed, and it does not follow from an
  // extension ban. A `.cjs` check would leave the property resting on the root
  // `package.json` saying `"type": "module"` — a manifest this graph walk never
  // reads and nothing here enforces — because a plain `.js` file is CommonJS or
  // ESM by that field alone. Node settles the question to execute the module;
  // the load hook reports what it decided. See MODULE_HOOKS_SOURCE for the
  // measured disagreement between the resolve-time and load-time answers.
  const { ok, stderr, loaded } = enumerateGraph(PREFLIGHT);
  assert.ok(ok, `bare node could not load the preflight graph:\n${stderr}`);
  // Liveness. An empty log satisfies the emptiness check below without having
  // asked the runtime anything — the same vacuity the file-count pin guards
  // against in the scan test.
  assert.ok(
    loaded.some((module) => module.format === "module"),
    `no ESM module was loaded at all, so the load hook is not firing: ${JSON.stringify(loaded)}`,
  );
  assert.deepEqual(
    commonjsModules(loaded),
    [],
    "a CommonJS module can bind `require` under any name, which a source scan cannot follow",
  );
});

test("the preflight production graph uses no runtime-resolved import form", () => {
  // A static-specifier ban is trivially evaded by `await import("micromark")`,
  // and after such a ban exists that is the ONLY form that still works — so it
  // is banned while the count is zero and no exemption list is needed.
  const { ok, stderr, files } = enumerateGraph(PREFLIGHT);
  assert.ok(ok, `bare node could not load the preflight graph:\n${stderr}`);
  // Pinned by NAME, not by count. `files.length > 1` would be satisfied with
  // zero margin by today's two-file graph, and would silently degrade to
  // scanning the entry file alone the day `lib/manifest.mjs` stops being
  // imported — a thinner scan reporting the same clean. Same liveness pin as
  // the allowlist test above, for the same reason.
  assert.ok(
    files.some((file) => file.endsWith(`${sep}lib${sep}manifest.mjs`)),
    `lib/manifest.mjs is not in the scanned set — the scan below covers only: ${files.join(", ")}`,
  );
  for (const file of files) {
    const found = dynamicLoadForms(readFileSync(file, "utf8"));
    assert.deepEqual(found, [], `${file} uses ${found.join(", ")} — invisible to the resolve hook`);
  }
});

// --- controls: each proves an assertion above can fail --------------------

/**
 * Run `body` against a throwaway module directory.
 *
 * The path is REALPATHED before use. On macOS `tmpdir()` is `/var/...`, a
 * symlink to `/private/var/...`, and node reports resolved module URLs through
 * the real path — so an un-normalised fixture root makes every target look like
 * it escaped, and the containment controls below would each pass on the wrong
 * arm. (Same normalisation, same reason, as preflight.mjs § isDirectlyInvoked.)
 */
function withModuleDirectory(files, body) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "preflight-fixture-")));
  try {
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(directory, name), content);
    }
    body(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("control: a bare specifier that does not resolve is still reported", () => {
  // The single most important control here. The failure this suite exists to
  // catch is an ADDED third-party import, and in the fresh worktree the
  // contract is about, that import does NOT resolve. A hook that logged after a
  // successful resolution would report nothing for it — measured, not assumed:
  // the log-after form omits this specifier entirely.
  withModuleDirectory({ "entry.mjs": 'import "totally-not-installed-package-xyz";\n' }, (dir) => {
    const { ok, records } = enumerateGraph(join(dir, "entry.mjs"));
    assert.equal(ok, false, "an uninstalled package must fail the child import");
    assert.ok(
      records.some((record) => record.specifier === "totally-not-installed-package-xyz"),
      `the unresolvable specifier was not reported — got: ${records.map((r) => r.specifier).join(", ")}`,
    );
  });
});

test("control: the child refuses a TypeScript source, so the floor assertion is not vacuous", () => {
  // Proves BOTH pinning mechanisms in enumerateGraph are live. If
  // `--no-experimental-strip-types` were dropped, or NODE_OPTIONS leaked this
  // suite's own `--experimental-strip-types` into the child, the child would
  // load the `.ts` below happily and this control would fail — which is the
  // only thing standing between the assertion above and a test that passes
  // because the runtime was never asked the question.
  withModuleDirectory(
    {
      "typed.ts": "export const value: number = 1;\n",
      "entry.mjs": 'import { value } from "./typed.ts";\n',
    },
    (dir) => {
      const { ok, stderr } = enumerateGraph(join(dir, "entry.mjs"));
      assert.equal(ok, false, "bare node must not load a .ts source at the engines floor");
      assert.match(
        stderr,
        /ERR_UNKNOWN_FILE_EXTENSION/,
        `expected a TypeScript load refusal, got:\n${stderr}`,
      );
    },
  );
});

test("control: a .cjs module in the graph is reported as CommonJS", () => {
  withModuleDirectory(
    {
      "legacy.cjs": "module.exports = { value: 1 };\n",
      "entry.mjs": 'import legacy from "./legacy.cjs";\nexport const value = legacy.value;\n',
    },
    (directory) => {
      const { ok, loaded } = enumerateGraph(join(directory, "entry.mjs"));
      assert.ok(ok, "the fixture must load — a control that fails to run proves nothing");
      const commonjs = commonjsModules(loaded);
      assert.equal(commonjs.length, 1, `expected one CommonJS module: ${JSON.stringify(loaded)}`);
      assert.match(commonjs[0], /legacy\.cjs$/);
    },
  );
});

test("control: a plain .js CommonJS module is caught, which an extension ban cannot do", () => {
  // The discriminating fixture, and the whole reason the assertion asks node
  // instead of reading filenames. Nothing about `helper.js` says CommonJS — not
  // its extension, not its contents until they are parsed as such. It is
  // CommonJS because the nearest `package.json` says so, a file two directories
  // of graph-walking would never open.
  //
  // A `.cjs` extension ban reports this graph clean while it holds a module
  // that can bind `require` under any name it likes. That is the same
  // proxy-instead-of-property failure the source-scanning revision of this
  // section was rewritten to remove.
  withModuleDirectory(
    {
      "package.json": '{ "name": "cjs-fixture", "type": "commonjs" }\n',
      "helper.js": "module.exports = { value: 1 };\n",
      "entry.mjs": 'import helper from "./helper.js";\nexport const value = helper.value;\n',
    },
    (directory) => {
      const { ok, loaded } = enumerateGraph(join(directory, "entry.mjs"));
      assert.ok(ok, "the fixture must load — a control that fails to run proves nothing");
      const commonjs = commonjsModules(loaded);
      assert.equal(
        commonjs.length,
        1,
        `the .js module must load as CommonJS: ${JSON.stringify(loaded)}`,
      );
      assert.match(commonjs[0], /helper\.js$/);
      // Stated as an assertion rather than left to the comment: the caught path
      // carries no CommonJS marker, so an extension check has nothing to see.
      assert.ok(
        !commonjs[0].endsWith(".cjs"),
        "this fixture only discriminates while the CommonJS module is NOT a .cjs file",
      );
    },
  );
});

test("control: a comment between `import` and `(` does not evade the dynamic-form scan", () => {
  // The shape that evaded BOTH layers at once, which is why it is a control
  // rather than a note. The call sits in a function nobody invokes at load
  // time, so the resolve hook never fires — the specifier is never resolved,
  // and a graph enumeration reports a clean two-file dependency-free walk. The
  // source scan was the only remaining net, and `\s*` cannot span a comment, so
  // it reported clean too. Two independent layers, one blind spot, no signal.
  const evasive = [
    "export function neverCalledAtLoadTime() {",
    '  return import /* optional */ ("third-party");',
    "}",
    "",
  ].join("\n");
  assert.deepEqual(dynamicLoadForms(evasive), ["dynamic import()"]);

  // The `require` analogue, including a line comment — which must consume its
  // newline, so the pattern cannot silently swallow the rest of the file.
  const evasiveRequire = ["const load = require // why", '  ("third-party");', ""].join("\n");
  assert.deepEqual(dynamicLoadForms(evasiveRequire), ["require()"]);
});

test("control: every non-url `import.meta` spelling is caught, not just the call", () => {
  // The round-5 finding. `import.meta.resolve` resolves a specifier WITHOUT
  // importing it, so neither hook ever fires; deferred in an uncalled function
  // it is invisible to the graph walk too, and the failure lands in the fresh
  // worktree at the moment the line first executes.
  //
  // Each spelling below defeats a named-call pattern in a different way, which
  // is the argument for allowlisting the continuation instead. They are checked
  // one per assertion so a failure names the spelling that regressed.
  const deferredCall = [
    "export function neverCalledAtLoadTime() {",
    '  return import.meta.resolve("third-party");',
    "}",
    "",
  ].join("\n");
  assert.deepEqual(dynamicLoadForms(deferredCall), ["import.meta (non-url)"]);

  // No parenthesis at the access site at all — a call pattern has nothing to
  // anchor on, and the capability escapes into a variable.
  const aliasedMethod = "const resolveSpecifier = import.meta.resolve;\n";
  assert.deepEqual(dynamicLoadForms(aliasedMethod), ["import.meta (non-url)"]);

  // The property name is a string, so no `.resolve` token exists to match.
  const computedAccess = 'const url = import.meta["resolve"]("third-party");\n';
  assert.deepEqual(dynamicLoadForms(computedAccess), ["import.meta (non-url)"]);

  // The whole object escapes; the resolution happens somewhere else entirely.
  const escapedObject = "const meta = import.meta;\n";
  assert.deepEqual(dynamicLoadForms(escapedObject), ["import.meta (non-url)"]);

  // Comments between every token, on both sides of the dot. `import . meta` is
  // one MetaProperty to the parser, so a gap-blind pattern misses all of these.
  const commentGaps = 'import /* a */ . /* b */ meta /* c */ . /* d */ resolve("third-party");\n';
  assert.deepEqual(dynamicLoadForms(commentGaps), ["import.meta (non-url)"]);
});

test("control: the widened patterns do not match ordinary static-import source", () => {
  // The widening only ever ADDS matches, so its risk is false positives on the
  // real graph rather than misses. This pins the shapes that must stay clean:
  // a static import (`import {` — the gap admits whitespace and comments, not
  // a brace), `import.meta.url`, and an identifier that merely ends in
  // `require`.
  //
  // The `.url` lines are load-bearing twice over. They are the graph's real
  // shape (both live occurrences are `.url`), and they are the ONLY thing
  // keeping the allowlist arm above from being a blanket `import.meta` ban that
  // would fail the production scan outright. The gapped spelling is here
  // because the allowlist admits gaps in the continuation as well as in the
  // prefix — if it did not, legal code would trip the gate.
  const ordinary = [
    'import { readFileSync } from "node:fs";',
    'import process from "node:process";',
    "const here = import.meta.url;",
    "const gapped = import.meta /* still legal */ . /* and here */ url;",
    "const configureRequire = () => 1;",
    "",
  ].join("\n");
  assert.deepEqual(dynamicLoadForms(ordinary), []);
});

test("control: a relative specifier reaching into node_modules is reported by name", () => {
  // The node_modules arm's discriminating input. This specifier passes the
  // relative-prefix allowlist, so only the resolved-path check can catch it —
  // and the fixture stays INSIDE the root it is checked against, so the
  // escaped-the-root arm cannot be what fires.
  withModuleDirectory({ "entry.mjs": 'import "./node_modules/pkg/index.mjs";\n' }, (dir) => {
    const packageDirectory = join(dir, "node_modules", "pkg");
    mkdirSync(packageDirectory, { recursive: true });
    writeFileSync(join(packageDirectory, "index.mjs"), "export const value = 1;\n");

    const { ok, records } = enumerateGraph(join(dir, "entry.mjs"));
    assert.ok(ok, "the fixture must load — a control that fails to run proves nothing");
    const violations = containmentViolations(records, dir);
    assert.equal(violations.length, 1, `expected one containment violation, got: ${violations}`);
    assert.match(violations[0], /resolves into node_modules/);
  });
});

test("control: a relative specifier escaping the root is reported by name", () => {
  // The complement arm. Both arms exist because they fail for different
  // reasons: this one catches a target that left the tree entirely, the one
  // above catches a target still inside it but unavailable before install.
  withModuleDirectory({ "sibling.mjs": "export const value = 1;\n" }, (outer) => {
    const escaping = `../${basename(outer)}/sibling.mjs`;
    withModuleDirectory({ "entry.mjs": `import "${escaping}";\n` }, (inner) => {
      const { ok, records } = enumerateGraph(join(inner, "entry.mjs"));
      assert.ok(ok, "the fixture must load — a control that fails to run proves nothing");
      const violations = containmentViolations(records, inner);
      assert.equal(violations.length, 1, `expected one containment violation, got: ${violations}`);
      assert.match(violations[0], /resolves outside/);
    });
  });
});

test("control: the dynamic-form scan catches every form it claims to", () => {
  // Proves the runtime-resolved ban can fail. Without it, the assertion would
  // pass against a scanner that silently matches nothing.
  assert.deepEqual(dynamicLoadForms('const mod = await import("micromark");'), [
    "dynamic import()",
  ]);
  assert.deepEqual(dynamicLoadForms('import { createRequire } from "node:module";'), [
    "createRequire",
  ]);
  assert.deepEqual(dynamicLoadForms('const fs = require("node:fs");'), ["require()"]);
  assert.deepEqual(dynamicLoadForms('const url = import.meta.resolve("micromark");'), [
    "import.meta (non-url)",
  ]);
  assert.deepEqual(dynamicLoadForms('import { readFileSync } from "node:fs";'), []);
});

test("control: the dynamic-form scan does NOT strip comments", () => {
  // Pins the deliberate strictness above as a decision rather than an
  // oversight. A commented-out dynamic import is still reported, because the
  // alternative — stripping comments before scanning — is the mechanism whose
  // string-literal blind spot this section was rewritten to remove.
  assert.deepEqual(dynamicLoadForms('// const mod = await import("micromark");'), [
    "dynamic import()",
  ]);
});
