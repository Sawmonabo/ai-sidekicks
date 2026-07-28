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
// per SKILL.md Phase 0.2, and on Node 22.12 (the `package.json` engines
// minimum) loading a `.ts` source fails with ERR_UNKNOWN_FILE_EXTENSION. The
// duplication is forced. What is NOT forced is leaving the two copies
// unchecked.
//
// The 4-space and tab entries below are the load-bearing ones: they are what
// distinguishes CommonMark's ` {0,3}` indent budget from a naive `\s*`, and
// the control test that follows goes vacuous if either is dropped.
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

test("control: the parity check can FAIL — a perturbed pattern is caught", () => {
  // Without this, a comparison of two identical no-op regexes would pass
  // forever and prove nothing. `\s*` is the naive form CommonMark rejects.
  const perturbed = /^(?:\s*>)+ ?/;
  const divergent = BLOCKQUOTE_CASES.filter(
    (line) => line.replace(perturbed, "") !== stripBlockquotePrefix(line),
  );
  assert.ok(
    divergent.length > 0,
    "the case list cannot distinguish a wrong pattern — it is not exercising the indentation rule",
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
// Both widenings below only ADD matches, so the fail-closed direction is
// preserved and prose like `import (something)` inside a comment now trips the
// gate. That is the intended strict direction and it costs nothing today —
// measured against the real graph, not assumed: the live match count is still
// zero, which the assertion in the scan test is what actually enforces.
// What may sit between a callee and its `(`. JS permits comments there —
// `import /* optional */ ("pkg")` is a valid dynamic import — and `\s*` cannot
// span a comment, so the narrower pattern missed that call entirely. The
// evasion was total rather than partial: a dynamic import inside a function
// that is never invoked at load time is also invisible to the resolve hook,
// because the call never executes, so BOTH layers reported clean.
const CALLEE_GAP = String.raw`(?:\s|/\*[\s\S]*?\*/|//[^\n]*\n)*`;

const DYNAMIC_LOAD_FORMS = [
  ["dynamic import()", new RegExp(String.raw`\bimport${CALLEE_GAP}\(`)],
  // A bare-word match — no parenthesis, so no gap to span.
  ["createRequire", /\bcreateRequire\b/],
  ["require()", new RegExp(String.raw`\brequire${CALLEE_GAP}\(`)],
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
const RESOLVE_HOOK_SOURCE = `import { appendFileSync } from "node:fs";

let logPath;
let bootstrapURL;

export function initialize(data) {
  logPath = data.logPath;
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
`;

const BOOTSTRAP_SOURCE = `import { register } from "node:module";
import { pathToFileURL } from "node:url";

const [entry, logPath] = process.argv.slice(2);
register("./resolve-hook.mjs", {
  parentURL: import.meta.url,
  data: { logPath, bootstrapURL: import.meta.url },
});
await import(pathToFileURL(entry).href);
`;

/**
 * Enumerate a module graph the way node itself does.
 *
 * @param {string} entry absolute path to the entry module
 * @returns {{ ok: boolean, stderr: string, files: string[],
 *             records: Array<{ specifier: string, parentURL: string | null, url: string | null }> }}
 */
function enumerateGraph(entry) {
  const directory = mkdtempSync(join(tmpdir(), "preflight-graph-"));
  try {
    const logPath = join(directory, "graph.jsonl");
    const bootstrap = join(directory, "bootstrap.mjs");
    writeFileSync(join(directory, "resolve-hook.mjs"), RESOLVE_HOOK_SOURCE);
    writeFileSync(bootstrap, BOOTSTRAP_SOURCE);
    writeFileSync(logPath, "");

    // The child must behave like the engines floor, not like whatever node the
    // developer or CI happens to run. Two mechanisms enforce that, and the
    // relationship between them was measured rather than assumed:
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
      ["--no-experimental-strip-types", bootstrap, entry, logPath],
      { encoding: "utf8", env: childEnvironment },
    );

    const records = readFileSync(logPath, "utf8")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line));

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

test("control: the widened patterns do not match ordinary static-import source", () => {
  // The widening only ever ADDS matches, so its risk is false positives on the
  // real graph rather than misses. This pins the shapes that must stay clean:
  // a static import (`import {` — the gap admits whitespace and comments, not
  // a brace), `import.meta`, and an identifier that merely ends in `require`.
  const ordinary = [
    'import { readFileSync } from "node:fs";',
    'import process from "node:process";',
    "const here = import.meta.url;",
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
