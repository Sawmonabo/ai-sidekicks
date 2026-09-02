// Plan-023 Phase 1B (T-023p-1B-2) — the build-time hardening assertion's own
// tests.
//
// `assert-webprefs.ts` is the enforcement mechanism behind
// `Spec-023 §Pitfalls To Avoid` ("`nodeIntegration: true` or `sandbox: false`
// in any window must be treated as a build-time error"), so it is exactly the
// kind of guard whose silent breakage is invisible: a script that always exits
// 0 looks identical to a codebase with no drift. These cases drive the REAL
// script as a child process over fixtures — importing its internals and
// re-checking the regexes inline would prove nothing about the artifact
// `pnpm build` actually runs.
//
// The two directions are asserted separately, because they fail differently:
// a false FAIL is a broken build somebody notices in a minute, while a false
// PASS ships a window with `sandbox: false`.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const scriptPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "assert-webprefs.ts");
const realWindowSourcePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src/main/window.ts",
);

let fixtureDirectory: string;

beforeAll(() => {
  fixtureDirectory = mkdtempSync(path.join(tmpdir(), "assert-webprefs-"));
});

afterAll(() => {
  rmSync(fixtureDirectory, { recursive: true, force: true });
});

interface AssertionRun {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

function runAssertion(targetPath: string, scanRoot?: string): AssertionRun {
  const result = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      scriptPath,
      targetPath,
      ...(scanRoot === undefined ? [] : [scanRoot]),
    ],
    { encoding: "utf8" },
  );
  return {
    status: result.status ?? -1,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

/**
 * Writes one fixture into a directory OF ITS OWN.
 *
 * Per case, not per suite: the script's tree scan defaults to the checked file's
 * own directory, so fixtures sharing one directory would each be scanned against
 * every other case's source — the stray-construction fixture would fail the
 * compliant case, and the suite would be asserting the wrong thing while still
 * being green on the arms that happen not to collide.
 */
function writeFixture(name: string, source: string): string {
  const caseDirectory = path.join(fixtureDirectory, name.replace(/\.tsx?$/, ""));
  mkdirSync(caseDirectory, { recursive: true });
  const fixturePath = path.join(caseDirectory, name);
  writeFileSync(fixturePath, source, "utf8");
  return fixturePath;
}

/** Writes a second file beside an existing fixture, in its own directory. */
function writeSiblingFixture(fixturePath: string, name: string, source: string): string {
  const siblingPath = path.join(path.dirname(fixturePath), name);
  writeFileSync(siblingPath, source, "utf8");
  return siblingPath;
}

/** A minimal module in the shape `window.ts` has: one locked block, one call. */
function compliantSource(overrides: Partial<Record<string, string>> = {}): string {
  const values = {
    contextIsolation: "true",
    sandbox: "true",
    nodeIntegration: "false",
    nodeIntegrationInWorker: "false",
    webSecurity: "true",
    ...overrides,
  };
  return [
    'import { BrowserWindow } from "electron";',
    "",
    "function constructLockedWindow() {",
    "  return new BrowserWindow({",
    "    webPreferences: {",
    `      contextIsolation: ${values.contextIsolation},`,
    `      sandbox: ${values.sandbox},`,
    `      nodeIntegration: ${values.nodeIntegration},`,
    `      nodeIntegrationInWorker: ${values.nodeIntegrationInWorker},`,
    `      webSecurity: ${values.webSecurity},`,
    "      preload: PRELOAD_PATH,",
    "    },",
    "  });",
    "}",
    "",
    "export { constructLockedWindow };",
    "",
  ].join("\n");
}

describe("assert-webprefs", () => {
  it("passes on the shipped window factory", () => {
    const run = runAssertion(realWindowSourcePath);

    expect(run.status).toBe(0);
    expect(run.stdout).toContain("exactly once");
  });

  it("passes on a minimal compliant module", () => {
    const run = runAssertion(writeFixture("compliant.ts", compliantSource()));

    expect(run.status).toBe(0);
  });

  describe("value drift", () => {
    it("fails when sandbox is disabled", () => {
      const run = runAssertion(
        writeFixture("sandbox-off.ts", compliantSource({ sandbox: "false" })),
      );

      expect(run.status).toBe(1);
      expect(run.stderr).toContain("sandbox");
    });

    it("fails when node integration is enabled", () => {
      const run = runAssertion(
        writeFixture("node-integration-on.ts", compliantSource({ nodeIntegration: "true" })),
      );

      expect(run.status).toBe(1);
      expect(run.stderr).toContain("nodeIntegration");
    });

    it("fails when context isolation is disabled", () => {
      const run = runAssertion(
        writeFixture("context-isolation-off.ts", compliantSource({ contextIsolation: "false" })),
      );

      expect(run.status).toBe(1);
      expect(run.stderr).toContain("contextIsolation");
    });
  });

  describe("the exactly-once conjunct", () => {
    // The regression the conjunct exists for: a second factory whose block is
    // NOT the locked one. A presence-only check passes this file.
    it("fails when a second, unchecked webPreferences block is added", () => {
      const source = [
        compliantSource(),
        "function constructAuxiliaryWindow() {",
        "  return new BrowserWindow({",
        "    webPreferences: {",
        "      sandbox: false,",
        "      nodeIntegration: true,",
        "    },",
        "  });",
        "}",
        "",
      ].join("\n");
      const run = runAssertion(writeFixture("second-block.ts", source));

      expect(run.status).toBe(1);
      expect(run.stderr).toContain("webPreferences");
      expect(run.stderr).toContain("found 2");
    });

    it("fails when a second BrowserWindow construction bypasses the locked factory", () => {
      const source = [
        compliantSource(),
        "function constructBareWindow() {",
        "  return new BrowserWindow({ width: 400, height: 300 });",
        "}",
        "",
      ].join("\n");
      const run = runAssertion(writeFixture("second-construction.ts", source));

      expect(run.status).toBe(1);
      expect(run.stderr).toContain("BrowserWindow");
    });
  });

  describe("source sanitization", () => {
    // A comment that quotes the locked value is not evidence the code sets it.
    it("does not accept a locked value that appears only in a comment", () => {
      const source = compliantSource({ sandbox: "false" }).replace(
        "      sandbox: false,",
        "      // Spec-023 requires sandbox: true here.\n      sandbox: false,",
      );
      const run = runAssertion(writeFixture("comment-only.ts", source));

      expect(run.status).toBe(1);
      expect(run.stderr).toContain("sandbox");
    });

    // The false-PASS direction the string-literal-aware scanner closes: with a
    // naive stripper the locked text inside a string satisfies the presence
    // check while the live block sets the opposite value.
    it("does not accept a locked value that appears only inside a string literal", () => {
      const source = [
        compliantSource({ sandbox: "false" }),
        'const diagnostic = "expected webPreferences: { sandbox: true } here";',
        "",
      ].join("\n");
      const run = runAssertion(writeFixture("string-literal.ts", source));

      expect(run.status).toBe(1);
      expect(run.stderr).toContain("sandbox");
    });

    // The false-FAIL direction: a URL inside a string is not a line comment,
    // so the rest of its line must survive sanitization.
    it("does not treat a URL inside a string literal as a line comment", () => {
      const source = [
        'import { BrowserWindow } from "electron";',
        'const documentUrl = "sidekicks-renderer://app/index.html"; const options = { webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, nodeIntegrationInWorker: false, webSecurity: true, preload: PRELOAD_PATH } };',
        "export const browserWindow = new BrowserWindow(options);",
        "export { documentUrl };",
        "",
      ].join("\n");
      const run = runAssertion(writeFixture("url-literal.ts", source));

      expect(run.status).toBe(0);
    });
  });

  // The conjunct the exactly-once counts structurally cannot supply: they are
  // scoped to one file, and a second module constructing its own window leaves
  // every count in the locked module at exactly one (Codex round 1).
  describe("the whole-tree construction scan", () => {
    it("fails when a sibling module constructs a window of its own", () => {
      const fixturePath = writeFixture("stray-sibling.ts", compliantSource());
      writeSiblingFixture(
        fixturePath,
        "menu.ts",
        [
          'import { BrowserWindow } from "electron";',
          "export function openSomething() {",
          "  return new BrowserWindow({ width: 400, height: 300 });",
          "}",
          "",
        ].join("\n"),
      );

      const run = runAssertion(fixturePath);

      expect(run.status).toBe(1);
      expect(run.stderr).toContain("menu.ts");
      expect(run.stderr).toContain("one locked factory");
    });

    it("fails when the stray construction is in a nested directory", () => {
      const fixturePath = writeFixture("stray-nested.ts", compliantSource());
      const nestedDirectory = path.join(path.dirname(fixturePath), "onboarding");
      mkdirSync(nestedDirectory, { recursive: true });
      writeFileSync(
        path.join(nestedDirectory, "walkthrough-host.ts"),
        [
          'import { BrowserWindow } from "electron";',
          "export const stray = new BrowserWindow({});",
          "",
        ].join("\n"),
        "utf8",
      );

      const run = runAssertion(fixturePath);

      expect(run.status).toBe(1);
      expect(run.stderr).toContain("walkthrough-host.ts");
    });

    // A sibling that only TALKS about the construction is not one — the same
    // sanitization the per-file checks run applies to every scanned file.
    it("passes when a sibling only mentions the construction in a comment", () => {
      const fixturePath = writeFixture("mentioning-sibling.ts", compliantSource());
      writeSiblingFixture(
        fixturePath,
        "notes.ts",
        [
          "// Every window is built by `new BrowserWindow(` in the locked factory.",
          'export const note = "never call new BrowserWindow( here";',
          "",
        ].join("\n"),
      );

      const run = runAssertion(fixturePath);

      expect(run.status).toBe(0);
    });

    // A scan that cannot read the tree must fail rather than report success for
    // a check it never ran.
    it("fails when the scanned tree does not exist", () => {
      const fixturePath = writeFixture("absent-tree.ts", compliantSource());

      const run = runAssertion(fixturePath, path.join(fixtureDirectory, "not-a-directory"));

      expect(run.status).toBe(1);
      expect(run.stderr).toContain("could not scan");
    });

    it("scans the shipped main-process tree by default", () => {
      const run = runAssertion(realWindowSourcePath);

      expect(run.status).toBe(0);
      expect(run.stdout).toContain("constructs a BrowserWindow");
    });
  });
});
