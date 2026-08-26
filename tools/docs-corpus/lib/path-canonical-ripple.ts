// path-canonical-ripple — enforces canonical-paths.json.
//
// For each (canonical, deprecated[]) pair, greps the configured scope for any
// surviving deprecated occurrence. Hard-fails if any occurrence is found
// outside the configured exclude paths.
//
// PR #24 cascade (line 14 fixed, lines 58/153/218 missed; then sibling-file
// 228 missed; then Tier-8 prose in three other plans missed) was specifically
// because no single grep covered "every surface form of THIS deprecated path".
// The registry plus this hook collapse the same-class sweep to one machine
// pass.

import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";

export interface PathEntry {
  canonical: string;
  deprecated: string[];
  /**
   * How `deprecated[]` entries are matched. `"literal"` (the default) greps
   * with `-F`, a fixed-string SUBSTRING match with no boundaries — the founding
   * `apps/desktop/` entry depends on exactly that, since the no-trailing-slash
   * form is what catches the executable/CLI shape (`--filter=apps/desktop/shell`)
   * that PR #24 missed. `"regex"` greps with `-E` (POSIX ERE) so an entry whose
   * deprecated forms are multi-token COMMAND INVOCATIONS can express boundaries
   * and whitespace tolerance, which a fixed string cannot.
   *
   * Opt-in per entry, never a global flip: boundary-wrapping every entry would
   * silently narrow the substring semantics entry 1 relies on.
   *
   * ERE only — no `\b`, no lookaround. `git grep -E` compiles through the
   * platform's regex engine, and the GNU extensions are not portable to the CI
   * matrix. Use `(^|[^[:alnum:]@/_-])` / `([^[:alnum:]_-]|$)` for boundaries.
   */
  matcher?: "literal" | "regex";
  introduced?: string;
  refs?: string[];
  scope?: string[];
  exclude?: string[];
  note?: string;
}

interface RegistryFile {
  paths: PathEntry[];
}

export interface PathRippleViolation {
  entry: PathEntry;
  deprecated: string;
  occurrences: { file: string; line: number; text: string }[];
}

function findRepoRoot(start: string): string {
  // Termination via parent-equals-current rather than `dir !== "/"` so the walk
  // terminates on Windows drive roots too. `path.dirname("C:\\")` returns
  // `"C:\\"` (idempotent), so the POSIX-only `dir !== "/"` guard would loop
  // forever there and hang the pre-commit hook with no diagnostic. The same
  // termination check covers POSIX root because `dirname("/") === "/"`.
  let dir = start;
  for (;;) {
    if (existsSync(resolve(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("could not locate repo root");
    dir = parent;
  }
}

function getRegistryPath(repoRoot: string): string {
  // Default to `tools/docs-corpus/canonical-paths.json`. Override via
  // `DOCS_CORPUS_REGISTRY` env var so tests can point at a fixture without
  // forking the source path constant.
  const override = process.env.DOCS_CORPUS_REGISTRY;
  if (override) return resolve(repoRoot, override);
  return resolve(repoRoot, "tools/docs-corpus/canonical-paths.json");
}

const VALID_MATCHERS = ["literal", "regex"] as const;

function validateRegistry(reg: RegistryFile, registryPath: string): void {
  // Fail closed on an unrecognized `matcher`. `loadRegistry` only CASTS the
  // parsed JSON, so a typo (`"regexp"`) or a value from stale documentation
  // (`"boundary"`) survives the cast, and a permissive `matcher === "regex"`
  // test downstream would treat every other string as the `-F` default. That
  // silently converts a boundary-aware regex needle into an inert fixed
  // string — the pattern's own metacharacters make it match nothing — and the
  // gate then reports clean over an axis it never checked. A gate reporting
  // clean over work it did not do is the failure this registry exists to
  // prevent, so an unknown value must refuse rather than degrade.
  for (const [index, entry] of reg.paths.entries()) {
    if (entry.matcher === undefined) continue;
    if ((VALID_MATCHERS as readonly string[]).includes(entry.matcher)) continue;
    throw new Error(
      `path-canonical-ripple: entry ${index} ("${entry.canonical}") in ${registryPath} declares ` +
        `matcher "${entry.matcher}", which is not one of ${VALID_MATCHERS.map((m) => `"${m}"`).join(" | ")}. ` +
        `Refusing rather than defaulting to literal: a regex needle matched as a fixed string finds nothing ` +
        `and the gate would report clean over an unchecked axis.`,
    );
  }
}

function loadRegistry(repoRoot: string): RegistryFile {
  const registryPath = getRegistryPath(repoRoot);
  if (!existsSync(registryPath)) {
    // Fail closed: a missing registry must surface as a hard failure, not a
    // silent pass. Returning an empty registry would disable the entire
    // canonical-path guard whenever the file is deleted, renamed, or its
    // override env var points at a bad path — exactly the scenario this
    // hook exists to prevent.
    throw new Error(`path-canonical-ripple: registry missing at ${registryPath}`);
  }
  const text = readFileSync(registryPath, "utf8");
  const registry = JSON.parse(text) as RegistryFile;
  validateRegistry(registry, registryPath);
  return registry;
}

function gitGrep(
  needle: string,
  matcher: "literal" | "regex",
  scope: string[],
  exclude: string[],
  cwd: string,
): { file: string; line: number; text: string }[] {
  // `--cached` searches the index instead of the working tree. Without it, a
  // tracked file with unstaged WIP that contains a deprecated path triggers a
  // hit even when the commit being made is unrelated and clean — the hook
  // blocks a no-op-with-respect-to-deprecated-paths commit. Searching the
  // index reflects exactly what the next commit would contribute, which is
  // the correct semantics for a pre-commit gate. In CI the working tree
  // matches HEAD after checkout, so the two modes produce identical results
  // there; the switch is purely additive.
  // Exhaustive by construction: `validateRegistry` has already refused any
  // value outside the union, so this switch cannot silently fall through to
  // the fixed-string arm for an unrecognized matcher.
  let modeFlag: string;
  switch (matcher) {
    case "regex":
      modeFlag = "-nE";
      break;
    case "literal":
      modeFlag = "-nF";
      break;
    default: {
      const unreachable: never = matcher;
      throw new Error(`path-canonical-ripple: unhandled matcher ${String(unreachable)}`);
    }
  }
  const args = ["grep", "--cached", modeFlag, "--", needle];
  for (const s of scope) args.push(":(glob)" + s);
  for (const e of exclude) args.push(":(exclude,glob)" + e);

  let out: string;
  try {
    out = execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      // Pipe stderr: with no stdio option, execFileSync also passes the
      // child's stderr through to the parent, bleeding a raw git error line
      // into hook output alongside the thrown message (which Node already
      // builds from the captured stderr) — same class as plan-manifest-
      // presence's fail-closed probe.
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    const e = err as { status?: number; stdout?: string };
    // `git grep` exits 1 for "no matches" — the clean outcome, not a fault.
    // Every other status is a fault and must throw: exit 128 is how a
    // malformed `-E` pattern surfaces, and swallowing it would turn an
    // uncompilable needle into a permanently green gate — the CAT-10 shape
    // this registry exists to avoid.
    if (e.status === 1) return [];
    throw new Error(
      `path-canonical-ripple: git grep --cached failed: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const idx1 = line.indexOf(":");
      const idx2 = line.indexOf(":", idx1 + 1);
      return {
        file: line.slice(0, idx1),
        line: Number.parseInt(line.slice(idx1 + 1, idx2), 10),
        text: line.slice(idx2 + 1),
      };
    });
}

export function checkPathCanonicalRipple(): PathRippleViolation[] {
  const repoRoot = findRepoRoot(process.cwd());
  const reg = loadRegistry(repoRoot);
  if (reg.paths.length === 0) return [];
  const hits: PathRippleViolation[] = [];
  for (const entry of reg.paths) {
    const scope = entry.scope ?? ["**/*.md"];
    const exclude = entry.exclude ?? [];
    const matcher = entry.matcher ?? "literal";
    for (const dep of entry.deprecated) {
      const found = gitGrep(dep, matcher, scope, exclude, repoRoot);
      if (found.length > 0) {
        hits.push({ entry, deprecated: dep, occurrences: found });
      }
    }
  }
  return hits;
}

export function formatPathRippleViolations(hits: PathRippleViolation[]): string {
  if (hits.length === 0) return "";
  const lines: string[] = [];
  lines.push("path-canonical-ripple: surviving deprecated path occurrences");
  lines.push("");
  for (const h of hits) {
    const how = h.entry.matcher === "regex" ? " (regex)" : "";
    lines.push(`  deprecated "${h.deprecated}"${how} — canonical is "${h.entry.canonical}"`);
    for (const occ of h.occurrences) {
      lines.push(`    ${occ.file}:${occ.line}: ${occ.text.trim()}`);
    }
    if (h.entry.note) lines.push(`    note: ${h.entry.note}`);
    if (h.entry.refs) lines.push(`    refs: ${h.entry.refs.join(", ")}`);
    lines.push("");
  }
  const totalOcc = hits.reduce((n, h) => n + h.occurrences.length, 0);
  lines.push(
    `path-canonical-ripple: ${totalOcc} occurrence(s) across ${hits.length} deprecated form(s). Replace with the canonical form, or add a tighter exclude rule to canonical-paths.json with a written rationale.`,
  );
  return lines.join("\n");
}
