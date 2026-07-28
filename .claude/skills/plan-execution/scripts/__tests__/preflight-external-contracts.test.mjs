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
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { BLOCKQUOTE_PREFIX_RE } from "../preflight.mjs";
import { stripBlockquotePrefix } from "../../../../../tools/docs-corpus/lib/markdown-fences.ts";

const SCRIPTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PREFLIGHT = resolve(SCRIPTS_DIR, "preflight.mjs");

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
// The walk is SEEDED at preflight.mjs and follows only relative specifiers, so
// the `__tests__/` boundary holds by construction rather than by a path
// exclusion — an exclusion broad enough to skip this directory would also
// excuse a future production violation.

const LINE_COMMENT = /\/\/[^\n]*/g;
const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g;

function stripComments(source) {
  return source.replace(BLOCK_COMMENT, "").replace(LINE_COMMENT, "");
}

/** Every module specifier this source imports or re-exports from. */
export function moduleSpecifiers(source) {
  const code = stripComments(source);
  const specifiers = [];
  for (const pattern of [
    /\b(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*["']([^"']+)["']/g,
  ]) {
    for (const match of code.matchAll(pattern)) specifiers.push(match[1]);
  }
  return specifiers;
}

/** Runtime-resolved import forms, which a specifier scan cannot see into. */
export function dynamicLoadForms(source) {
  const code = stripComments(source);
  const found = [];
  if (/\bimport\s*\(/.test(code)) found.push("dynamic import()");
  if (/\bcreateRequire\b/.test(code)) found.push("createRequire");
  if (/\brequire\s*\(/.test(code)) found.push("require()");
  return found;
}

export function walkProductionGraph(entry) {
  const visited = new Set();
  const queue = [entry];
  const modules = [];
  while (queue.length > 0) {
    const file = queue.shift();
    if (visited.has(file)) continue;
    visited.add(file);
    const source = readFileSync(file, "utf8");
    const specifiers = moduleSpecifiers(source);
    modules.push({ file, specifiers, dynamic: dynamicLoadForms(source) });
    for (const specifier of specifiers) {
      if (specifier.startsWith("./") || specifier.startsWith("../")) {
        const target = resolve(dirname(file), specifier);
        // Fail CLOSED and by name. ESM requires relative specifiers to carry
        // their extension, so an extensionless or directory specifier does not
        // resolve here for the same reason it would not resolve at runtime —
        // without this, `readFileSync` throws a bare ENOENT and the gate dies
        // on an unreadable stack instead of naming what it could not follow.
        assert.ok(
          existsSync(target),
          `${file} imports "${specifier}", which resolves to no file (${target}) — an ESM relative specifier must name an existing file, extension included`,
        );
        queue.push(target);
      }
    }
  }
  return modules;
}

test("the preflight production graph imports only node: builtins and relatives", () => {
  const modules = walkProductionGraph(PREFLIGHT);
  // A count alone would pass against a walk that never left the entry file.
  // Naming a module reachable ONLY through a relative specifier proves the
  // traversal edge is live; the set is deliberately not pinned as exhaustive,
  // so a legitimately-added module is discovered rather than rejected.
  assert.ok(
    modules.some((module) => module.file.endsWith("/lib/manifest.mjs")),
    `walk never followed a relative import — reached only: ${modules.map((m) => m.file).join(", ")}`,
  );
  for (const { file, specifiers } of modules) {
    for (const specifier of specifiers) {
      const allowed =
        specifier.startsWith("node:") || specifier.startsWith("./") || specifier.startsWith("../");
      assert.ok(
        allowed,
        `${file} imports "${specifier}" — the preflight graph must stay dependency-free (SKILL.md Phase 0.2 runs it under bare node, before any install)`,
      );
    }
  }
});

test("the preflight production graph uses no runtime-resolved import form", () => {
  // A static-specifier ban is trivially evaded by `await import("micromark")`,
  // and after such a ban exists that is the ONLY form that still works — so it
  // is banned while the count is zero and no exemption list is needed.
  for (const { file, dynamic } of walkProductionGraph(PREFLIGHT)) {
    assert.deepEqual(
      dynamic,
      [],
      `${file} uses ${dynamic.join(", ")} — invisible to the import ban`,
    );
  }
});

test("the preflight production graph loads no .ts source", () => {
  // On Node 22.12 — the `package.json` engines minimum, and so the floor this
  // skill must run on — bare `node` fails ERR_UNKNOWN_FILE_EXTENSION on a `.ts`
  // source. Newer Node strips types by default, which is exactly why this needs
  // to be a test: the claim is about the FLOOR, and passing on a developer's
  // newer runtime would otherwise read as the constraint having lifted.
  //
  // The shared fence tracker is a `.ts` module, so this is the guard that stops
  // "just import the canonical one" from being applied to production — the same
  // reason the blockquote duplication above is forced. It ENCODES that
  // constraint; it does not resolve the duplication, which is Tier-2 work.
  //
  // Only relative `.ts` specifiers reach here; a bare one is already refused by
  // the dependency test above. Both are kept — they fail for different reasons
  // and a reader should not have to derive one from the other.
  for (const { file, specifiers } of walkProductionGraph(PREFLIGHT)) {
    for (const specifier of specifiers) {
      assert.ok(
        !specifier.endsWith(".ts"),
        `${file} imports "${specifier}" — bare node cannot load a .ts source (ERR_UNKNOWN_FILE_EXTENSION)`,
      );
    }
  }
});

test("control: the extractor catches every banned form it claims to", () => {
  // Proves the three assertions above can fail. Without it they would pass
  // against an extractor that silently matches nothing.
  const bad = [
    'import { z } from "zod";',
    'import "side-effect-package";',
    'export { thing } from "@scope/pkg";',
    'const mod = await import("micromark");',
    'import { createRequire } from "node:module";',
  ].join("\n");
  const specifiers = moduleSpecifiers(bad);
  assert.ok(specifiers.includes("zod"), "missed a named static import");
  assert.ok(specifiers.includes("side-effect-package"), "missed a side-effect import");
  assert.ok(specifiers.includes("@scope/pkg"), "missed a re-export specifier");
  assert.ok(dynamicLoadForms(bad).includes("dynamic import()"), "missed a dynamic import");
  assert.ok(dynamicLoadForms(bad).includes("createRequire"), "missed createRequire");
});

test("control: an unfollowable relative import fails by name, not by ENOENT", () => {
  // The walk's fail-closed guard. Today every relative specifier in the graph
  // carries its extension, so the guard never fires against the real tree —
  // which is exactly why it needs a synthetic input to prove it CAN. A guard
  // that has never been observed failing is indistinguishable from one that is
  // wired wrong, and the failure it replaces (a raw ENOENT out of readFileSync)
  // would surface as a stack trace naming neither the importer nor the import.
  const directory = mkdtempSync(join(tmpdir(), "preflight-walk-"));
  try {
    const entry = join(directory, "entry.mjs");
    writeFileSync(entry, 'import { thing } from "./lib/extensionless";\n');
    // The `entry.mjs` conjunct is the load-bearing one. A raw ENOENT out of
    // readFileSync — the exact failure this guard replaces — carries the
    // resolved path and so satisfies the specifier check on its own; only the
    // IMPORTER name is unique to the guard's own message. Collapsing this to a
    // single `includes` would leave a control that passes on the crash.
    assert.throws(
      () => walkProductionGraph(entry),
      (error) =>
        error.message.includes("./lib/extensionless") && error.message.includes("entry.mjs"),
      "the walk must name both the importer and the specifier it could not follow",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("control: a commented-out import is not counted", () => {
  const source = [
    '// import { z } from "zod";',
    '/* import "pkg"; */',
    'import x from "node:fs";',
  ].join("\n");
  assert.deepEqual(moduleSpecifiers(source), ["node:fs"]);
});
