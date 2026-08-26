import { describe, it, expect } from "vitest";
import { writeFileSync, readFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import {
  checkPathCanonicalRipple,
  formatPathRippleViolations,
  type PathEntry,
} from "../lib/path-canonical-ripple.ts";

function setupRepo(
  files: Record<string, string>,
  registry: object,
): { root: string; cleanup: () => void } {
  const root = mkdtempSync(resolve(tmpdir(), "pcr-"));
  execSync("git init -q -b main", { cwd: root });
  execSync("git config user.email test@test", { cwd: root });
  execSync("git config user.name test", { cwd: root });
  for (const [path, content] of Object.entries(files)) {
    const full = resolve(root, path);
    mkdirSync(resolve(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  // Place the registry at a non-canonical path and point the lib at it via
  // DOCS_CORPUS_REGISTRY env. Avoids leaking the canonical
  // `tools/docs-corpus/...` path into the test's git tree (and into the
  // path-canonical-ripple sweep itself).
  writeFileSync(resolve(root, "registry.json"), JSON.stringify(registry, null, 2));
  execSync("git add -A && git commit -q -m bootstrap", { cwd: root });
  return { root, cleanup: () => rmSync(root, { recursive: true }) };
}

function runCheck(root: string): { hits: ReturnType<typeof checkPathCanonicalRipple> } {
  const prevCwd = process.cwd();
  const prevRegistry = process.env.DOCS_CORPUS_REGISTRY;
  try {
    process.chdir(root);
    process.env.DOCS_CORPUS_REGISTRY = "registry.json";
    const hits = checkPathCanonicalRipple();
    return { hits };
  } finally {
    process.chdir(prevCwd);
    if (prevRegistry === undefined) delete process.env.DOCS_CORPUS_REGISTRY;
    else process.env.DOCS_CORPUS_REGISTRY = prevRegistry;
  }
}

describe("path-canonical-ripple", () => {
  it("REJECTS PR-#24 surviving 'apps/desktop/shell' references", () => {
    const { root, cleanup } = setupRepo(
      {
        "docs/decisions/022-toolchain.md": [
          "uses apps/desktop/ canonical",
          "pnpm rebuild --filter=apps/desktop/shell better-sqlite3",
          "second occurrence: apps/desktop/shell",
          "third: apps/desktop/shell stuff",
        ].join("\n"),
        "docs/architecture/cross-plan-dependencies.md":
          "apps/desktop/renderer references go here\n",
      },
      {
        paths: [
          {
            canonical: "apps/desktop/",
            deprecated: ["apps/desktop/shell", "apps/desktop/renderer"],
            scope: ["docs/**/*.md"],
            exclude: ["docs/archive/**"],
          },
        ],
      },
    );
    const { hits } = runCheck(root);
    const formatted = formatPathRippleViolations(hits);
    expect(hits.length).toBeGreaterThan(0);
    expect(formatted).toMatch(/apps\/desktop\/shell/);
    expect(formatted).toMatch(/apps\/desktop\/renderer/);
    cleanup();
  });

  it("ACCEPTS the canonicalized state", () => {
    const { root, cleanup } = setupRepo(
      {
        "docs/decisions/022-toolchain.md": "uses apps/desktop/ everywhere\n",
      },
      {
        paths: [
          {
            canonical: "apps/desktop/",
            deprecated: ["apps/desktop/shell", "apps/desktop/renderer"],
            scope: ["docs/**/*.md"],
            exclude: ["docs/archive/**"],
          },
        ],
      },
    );
    const { hits } = runCheck(root);
    expect(hits).toEqual([]);
    cleanup();
  });

  it("RESPECTS the archive exclude rule", () => {
    const { root, cleanup } = setupRepo(
      {
        "docs/archive/old-plan.md": "historical apps/desktop/shell reference\n",
      },
      {
        paths: [
          {
            canonical: "apps/desktop/",
            deprecated: ["apps/desktop/shell"],
            scope: ["docs/**/*.md"],
            exclude: ["docs/archive/**"],
          },
        ],
      },
    );
    const { hits } = runCheck(root);
    expect(hits).toEqual([]);
    cleanup();
  });

  it("IGNORES unstaged working-tree edits to tracked files", () => {
    // Codex review on PR #27: the prior `git grep` invocation omitted
    // `--cached` and therefore scanned the working tree, so a tracked file
    // with unrelated WIP containing a deprecated path could block a clean
    // commit. A pre-commit gate should reflect what the next commit would
    // contribute (i.e. the index), not arbitrary unstaged drift.
    const root = mkdtempSync(resolve(tmpdir(), "pcr-wip-"));
    execSync("git init -q -b main", { cwd: root });
    execSync("git config user.email test@test", { cwd: root });
    execSync("git config user.name test", { cwd: root });
    mkdirSync(resolve(root, "docs"), { recursive: true });
    writeFileSync(resolve(root, "docs/clean.md"), "uses apps/desktop/ everywhere\n");
    writeFileSync(
      resolve(root, "registry.json"),
      JSON.stringify(
        {
          paths: [
            {
              canonical: "apps/desktop/",
              deprecated: ["apps/desktop/shell"],
              scope: ["docs/**/*.md"],
              exclude: ["docs/archive/**"],
            },
          ],
        },
        null,
        2,
      ),
    );
    execSync("git add -A && git commit -q -m bootstrap", { cwd: root });
    // Introduce a deprecated string in the working tree only — do NOT stage.
    writeFileSync(
      resolve(root, "docs/clean.md"),
      "uses apps/desktop/ everywhere\nWIP: apps/desktop/shell mention\n",
    );
    const prevCwd = process.cwd();
    const prevRegistry = process.env.DOCS_CORPUS_REGISTRY;
    try {
      process.chdir(root);
      process.env.DOCS_CORPUS_REGISTRY = "registry.json";
      const hits = checkPathCanonicalRipple();
      expect(hits).toEqual([]);
      // Sanity check the inverse: once the WIP is staged, the same content
      // SHOULD be flagged. Confirms `--cached` is the only source of the
      // earlier acceptance and the hook still catches deprecated paths in
      // the index.
      execSync("git add docs/clean.md", { cwd: root });
      const stagedHits = checkPathCanonicalRipple();
      expect(stagedHits.length).toBeGreaterThan(0);
      expect(stagedHits[0].deprecated).toBe("apps/desktop/shell");
    } finally {
      process.chdir(prevCwd);
      if (prevRegistry === undefined) delete process.env.DOCS_CORPUS_REGISTRY;
      else process.env.DOCS_CORPUS_REGISTRY = prevRegistry;
      rmSync(root, { recursive: true });
    }
  });

  // ---------------------------------------------------------------------
  // matcher: "regex" — opt-in boundary-aware matching for entries whose
  // deprecated forms are multi-token COMMAND INVOCATIONS rather than paths.
  //
  // These drive the REAL needles out of the shipped canonical-paths.json
  // against planted fixtures, rather than restating patterns inline. A test
  // that re-spells the needles proves only that the test author can write a
  // regex; it would keep passing while the registry's own needle rotted.
  // ---------------------------------------------------------------------

  function cliEntryFromRealRegistry(): PathEntry {
    const registryPath = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "canonical-paths.json",
    );
    const registry = JSON.parse(readFileSync(registryPath, "utf8")) as { paths: PathEntry[] };
    // The CLI-invocation entry is the `sidekicks` entry scoped over docs — the
    // sibling `sidekicks` entry is source-scoped and carries no docs glob.
    const entry = registry.paths.find(
      (e) => e.canonical === "sidekicks" && (e.scope ?? []).includes("docs/**/*.md"),
    );
    if (!entry) throw new Error("CLI invocation entry not found in canonical-paths.json");
    return entry;
  }

  it("REGEX MATCHER catches whitespace variants a fixed string misses", () => {
    // The under-match half. `git grep -F` needles carry exactly one literal
    // space, so an invocation written with a run of spaces or a tab silently
    // passed the gate. Each line here is a real regression that must fail.
    const entry = cliEntryFromRealRegistry();
    const { root, cleanup } = setupRepo(
      {
        "docs/operations/runbook.md": [
          "Run `ai-sidekicks  daemon status` with two spaces.",
          "Run `ai-sidekicks\tdaemon status` with a tab.",
          'Bin map: {"bin":{"ai-sidekicks" : "./dist/main.js"}} with spaced colon.',
          "Flag-first: ai-sidekicks --help",
        ].join("\n"),
      },
      { paths: [{ ...entry, exclude: [] }] },
    );
    const { hits } = runCheck(root);
    const flagged = hits.flatMap((h) => h.occurrences.map((o) => o.line));
    expect(new Set(flagged)).toEqual(new Set([1, 2, 3, 4]));
    cleanup();
  });

  it("REGEX MATCHER does not fire on legitimate unchanged project-name prose", () => {
    // The over-match half, and the more corrosive one: a false CI failure
    // pressures authors toward broad `exclude` entries that weaken the gate.
    // Line 1 is the exact prose that failed CI on this entry's own PR.
    // Lines 2-5 are the deliberately-unchanged surfaces the entry's `note`
    // enumerates — every one contains the project name as a substring.
    const entry = cliEntryFromRealRegistry();
    const { root, cleanup } = setupRepo(
      {
        "docs/backlog.md": [
          "npm trust github pkg --repository owner/ai-sidekicks --environment production",
          "The ai-sidekicks configuration directory holds the key-ring.",
          "While ai-sidekicks runs locally the daemon owns the socket.",
          'Root manifest: {"name": "ai-sidekicks"} and scope @ai-sidekicks/contracts.',
          "Keystore prefix ai-sidekicks:paseto-refresh-token is unchanged.",
        ].join("\n"),
      },
      { paths: [{ ...entry, exclude: [] }] },
    );
    const { hits } = runCheck(root);
    expect(hits).toEqual([]);
    cleanup();
  });

  it("REGEX MATCHER is opt-in — entries without it keep substring semantics", () => {
    // Entry 1 (`apps/desktop/`) DEPENDS on unbounded substring matching: the
    // no-trailing-slash form is what catches the executable shape
    // `--filter=apps/desktop/shell` that PR #24 missed. If `matcher` ever
    // defaulted to regex, or the default silently boundary-wrapped, this
    // registry's founding instance would narrow without a single test failing.
    const { root, cleanup } = setupRepo(
      { "docs/a.md": "pnpm rebuild --filter=apps/desktop/shell better-sqlite3\n" },
      {
        paths: [
          {
            canonical: "apps/desktop/",
            deprecated: ["apps/desktop/shell"],
            scope: ["docs/**/*.md"],
          },
        ],
      },
    );
    const { hits } = runCheck(root);
    expect(hits).toHaveLength(1);
    expect(hits[0].occurrences).toHaveLength(1);
    cleanup();
  });

  it("REGEX MATCHER treats regex metacharacters as syntax, literal does not", () => {
    // Proves the two modes actually reach different git flags, rather than
    // both landing on -F and the regex entries passing by luck. The same
    // needle is a wildcard under -E and an inert literal under -F.
    const files = { "docs/a.md": "apps/desktopXshell\n" };
    const asRegex = setupRepo(files, {
      paths: [
        {
          canonical: "apps/desktop/",
          matcher: "regex",
          deprecated: ["apps/desktop.shell"],
          scope: ["docs/**/*.md"],
        },
      ],
    });
    expect(runCheck(asRegex.root).hits).toHaveLength(1);
    asRegex.cleanup();

    const asLiteral = setupRepo(files, {
      paths: [
        { canonical: "apps/desktop/", deprecated: ["apps/desktop.shell"], scope: ["docs/**/*.md"] },
      ],
    });
    expect(runCheck(asLiteral.root).hits).toEqual([]);
    asLiteral.cleanup();
  });

  it("FAILS CLOSED on an uncompilable regex needle", () => {
    // `git grep` exits 128 on a malformed pattern. Only exit 1 means "no
    // matches"; if any other status were swallowed as clean, an uncompilable
    // needle would render the gate permanently green — the CAT-10 shape of a
    // gate reporting clean over work it never did.
    const { root, cleanup } = setupRepo(
      { "docs/a.md": "anything\n" },
      {
        paths: [
          {
            canonical: "x",
            matcher: "regex",
            deprecated: ["a[unterminated"],
            scope: ["docs/**/*.md"],
          },
        ],
      },
    );
    const prevCwd = process.cwd();
    const prevRegistry = process.env.DOCS_CORPUS_REGISTRY;
    try {
      process.chdir(root);
      process.env.DOCS_CORPUS_REGISTRY = "registry.json";
      expect(() => checkPathCanonicalRipple()).toThrow(/git grep --cached failed/i);
    } finally {
      process.chdir(prevCwd);
      if (prevRegistry === undefined) delete process.env.DOCS_CORPUS_REGISTRY;
      else process.env.DOCS_CORPUS_REGISTRY = prevRegistry;
      cleanup();
    }
  });

  it("REFUSES an unknown matcher instead of silently downgrading to literal", () => {
    // `loadRegistry` only CASTS the parsed JSON, so a typo or a value from
    // stale documentation survives the cast. If the consuming branch were
    // permissive (anything-but-"regex" -> -F), a boundary-aware needle would
    // be matched as a fixed string, find nothing because its own
    // metacharacters are inert, and the gate would report CLEAN over an axis
    // it never checked — this catalog's CAT-10 shape. The refusal must
    // therefore fire at load, before any grep runs.
    const { root, cleanup } = setupRepo(
      { "docs/a.md": "ai-sidekicks daemon status\n" },
      {
        paths: [
          {
            canonical: "sidekicks",
            matcher: "boundary",
            deprecated: ["(^|[^[:alnum:]@/_-])ai-sidekicks[[:space:]]+daemon"],
            scope: ["docs/**/*.md"],
          },
        ],
      },
    );
    const prevCwd = process.cwd();
    const prevRegistry = process.env.DOCS_CORPUS_REGISTRY;
    try {
      process.chdir(root);
      process.env.DOCS_CORPUS_REGISTRY = "registry.json";
      expect(() => checkPathCanonicalRipple()).toThrow(/matcher "boundary".*not one of/is);
    } finally {
      process.chdir(prevCwd);
      if (prevRegistry === undefined) delete process.env.DOCS_CORPUS_REGISTRY;
      else process.env.DOCS_CORPUS_REGISTRY = prevRegistry;
      cleanup();
    }
  });

  it("REAL REGISTRY: every shipped needle matches its intended form", () => {
    // Drives ALL needles of BOTH shipped `sidekicks` entries — the two
    // regex-entry fixtures above cover the verb / JSON-key / flag-first
    // patterns, and this one closes the remainder so no shipped pattern can
    // rot behind a green suite: the prose `bin` shorthand, the deep-link
    // scheme, and the source-scoped protocol-call needle (which lives on a
    // separate entry with a source-only scope, so it needs a source fixture).
    //
    // Asserted as a needle-level SET EQUALITY, not a count: every needle in
    // both entries must fire exactly once. A new needle added to the registry
    // without a fixture here fails this test rather than riding along unproven.
    const registryPath = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "canonical-paths.json",
    );
    const registry = JSON.parse(readFileSync(registryPath, "utf8")) as { paths: PathEntry[] };
    const entries = registry.paths.filter((e) => e.canonical === "sidekicks");
    expect(entries).toHaveLength(2);

    const { root, cleanup } = setupRepo(
      {
        // Exercises the docs-scoped entry: verb, flag-first, JSON key,
        // prose `bin` shorthand, deep-link scheme.
        "docs/plans/007.md": [
          "Run `ai-sidekicks  daemon status` after install.",
          "Global flags: ai-sidekicks --version",
          'Manifest: {"bin":{"ai-sidekicks" : "./dist/main.js"}}',
          'Prose restatement: bin: "ai-sidekicks" points at the bundle.',
          "Deep link: ai-sidekicks://invite/abc",
        ].join("\n"),
        // Exercises the source-scoped entry, which carries no docs glob.
        "apps/desktop/src/main/protocol.ts": "app.setAsDefaultProtocolClient(`ai-sidekicks`);\n",
      },
      { paths: entries.map((e) => ({ ...e, exclude: [] })) },
    );
    const { hits } = runCheck(root);
    const fired = new Set(hits.map((h) => h.deprecated));
    const shipped = new Set(entries.flatMap((e) => e.deprecated));
    expect(fired).toEqual(shipped);
    for (const hit of hits) expect(hit.occurrences).toHaveLength(1);
    cleanup();
  });

  it("REGISTRY SHAPE: no deprecated entry ends with '/' (substring-match contract)", () => {
    // Codex review on PR #27 commit c09ce2f: a deprecated entry like
    // `apps/desktop/shell/` (with trailing slash) only catches the
    // literal-path form via `git grep -F` substring matching; it MISSES the
    // executable / CLI form `--filter=apps/desktop/shell` that PR #24 round 1
    // famously failed to canonicalize. The no-slash form catches BOTH.
    //
    // This test guards the registry shape itself, not the runtime behavior:
    // if a future contributor adds a deprecated entry with a trailing slash,
    // this test fires loudly so the CLI-form blind spot does not silently
    // re-emerge. If a slash IS load-bearing for a future entry (e.g. when
    // the substring would false-positive), document the rationale in the
    // entry's `note` field and add an explicit allowlist exception here.
    //
    // Allowlist, keyed `${canonical}::${deprecated}`. Exactly one entry: the
    // `sidekicks` CLI entry's deep-link-scheme needle. Its trailing `//` is the
    // URL-scheme delimiter and is load-bearing against a false positive, not a
    // directory slash. Trimming it to one slash still ends in a slash, and
    // trimming further to the bare `ai-sidekicks:` prefix would match the
    // deliberately-unchanged keystore key prefix (`ai-sidekicks:*`, e.g. the
    // `paseto-refresh-token` key in Plan-023). There is no CLI / executable
    // form of a URL scheme, so the blind spot this rule guards does not exist
    // for this needle. Rationale mirrored in the entry's `note` per the
    // instruction above.
    //
    // The key is DERIVED from the registry rather than written out, so the
    // allowlist cannot silently widen: it resolves only if the entry still has
    // exactly one slash-terminated needle. Spelling it as a literal would make
    // this test the one place a dead executable form survives in-tree, and
    // would re-approve a DIFFERENT needle if the scheme spelling ever changed.
    const cliEntry = JSON.parse(
      readFileSync(
        resolve(dirname(fileURLToPath(import.meta.url)), "..", "canonical-paths.json"),
        "utf8",
      ),
    ) as { paths: { canonical: string; deprecated: string[] }[] };
    const schemeNeedles = cliEntry.paths
      .filter((e) => e.canonical === "sidekicks")
      .flatMap((e) => e.deprecated)
      .filter((d) => d.endsWith("/"));
    expect(schemeNeedles).toHaveLength(1);
    const SLASH_ALLOWLIST = new Set([`sidekicks::${schemeNeedles[0]}`]);
    const here = dirname(fileURLToPath(import.meta.url));
    const registryPath = resolve(here, "..", "canonical-paths.json");
    const registry = JSON.parse(readFileSync(registryPath, "utf8")) as {
      paths: { canonical: string; deprecated: string[] }[];
    };
    const slashy: { canonical: string; deprecated: string }[] = [];
    for (const entry of registry.paths) {
      for (const dep of entry.deprecated) {
        if (!dep.endsWith("/")) continue;
        if (SLASH_ALLOWLIST.has(`${entry.canonical}::${dep}`)) continue;
        slashy.push({ canonical: entry.canonical, deprecated: dep });
      }
    }
    expect(slashy).toEqual([]);
  });

  it("TERMINATES the repo-root walk at the filesystem root (Windows drive-root parity)", () => {
    // Codex review on PR #27 commit 90b6e40: the repo-root walk terminated on
    // `dir !== "/"` which is POSIX-specific. `path.dirname("C:\\")` returns
    // `"C:\\"` (idempotent at the drive root), so a Windows pre-commit hook
    // would loop forever with no diagnostic. The fix terminates on
    // parent-equals-current, which works on both POSIX (`dirname("/") === "/"`)
    // and Windows. This test exercises the termination path on the host
    // platform — if the loop ever regressed to the POSIX-only guard, vitest's
    // per-test timeout would catch the hang. The same termination logic
    // mechanically applies to Windows because the predicate is path-string
    // equality, not a hard-coded sentinel.
    const root = mkdtempSync(resolve(tmpdir(), "pcr-noroot-"));
    // Intentionally do NOT `git init` — the walk must reach the filesystem
    // root and terminate there rather than spinning.
    const prevCwd = process.cwd();
    try {
      process.chdir(root);
      expect(() => checkPathCanonicalRipple()).toThrow(/could not locate repo root/i);
    } finally {
      process.chdir(prevCwd);
      rmSync(root, { recursive: true });
    }
  });

  it("FAILS CLOSED when the registry file is missing", () => {
    // Codex review on PR #27: prior behavior logged a warning and returned an
    // empty registry, silently disabling the canonical-path guard if the file
    // was deleted/renamed. An enforcement gate must fail loudly when its
    // policy source vanishes — silent disable is the worst outcome.
    const root = mkdtempSync(resolve(tmpdir(), "pcr-missing-"));
    execSync("git init -q -b main", { cwd: root });
    execSync("git config user.email test@test", { cwd: root });
    execSync("git config user.name test", { cwd: root });
    execSync("git commit -q --allow-empty -m bootstrap", { cwd: root });
    const prevCwd = process.cwd();
    const prevRegistry = process.env.DOCS_CORPUS_REGISTRY;
    try {
      process.chdir(root);
      process.env.DOCS_CORPUS_REGISTRY = "registry.json";
      expect(() => checkPathCanonicalRipple()).toThrow(/path-canonical-ripple: registry missing/i);
    } finally {
      process.chdir(prevCwd);
      if (prevRegistry === undefined) delete process.env.DOCS_CORPUS_REGISTRY;
      else process.env.DOCS_CORPUS_REGISTRY = prevRegistry;
      rmSync(root, { recursive: true });
    }
  });
});
