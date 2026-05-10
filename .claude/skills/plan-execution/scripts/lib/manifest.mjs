// Shared schema + parser + validator + writer for the in-plan
// `### Shipment Manifest` block. Both consumers — the post-merge
// housekeeper (write-side, via the orchestrator that owns the plan
// file edit per SKILL.md Phase E step 6) and the preflight tool
// (read-side, Gate 3 + Gate 5 plan_phase resolver) — import from
// this module so the schema cannot drift between them.
//
// ## Schema (version 1)
//
//     manifest_schema_version: 1
//     shipped:
//       - phase: <int>
//         task: <string | string[]>   # array allowed for legacy multi-task PRs
//         pr: <int>
//         sha: <string>               # short hex (7-40 chars)
//         merged_at: YYYY-MM-DD
//         files: [path1, path2, ...]
//         verifies_invariant: [I-NNN-N, ...]
//         spec_coverage: [Spec-NNN row 4, ...]
//         notes: |
//           optional free-form text
//
// ## Schema-version policy
//
// Parser accepts version >= 1. Unknown future versions are returned
// with `{ ok: true, version, shipped }` so callers can fail-open
// (preflight Gate 3 treats unknown-version manifests as opaque rather
// than block-dispatch — partial migrations during a future schema bump
// must not halt orchestration).
//
// ## Why hand-rolled (not Zod)
//
// Both consumers (preflight + housekeeper) currently import only
// `node:fs`/`path`/`process` — adding a single Zod dependency for one
// 9-field flat schema breaks suite-level zero-dep consistency. The
// validation surface is small enough that hand-rolled is more
// maintainable than a schema-library indirection.

export const MANIFEST_SCHEMA_VERSION = 1;
export const MANIFEST_SECTION_HEADING = "### Shipment Manifest";

const ENTRY_KEYS = new Set([
  "phase",
  "task",
  "pr",
  "sha",
  "merged_at",
  "files",
  "verifies_invariant",
  "spec_coverage",
  "notes",
]);
const REQUIRED_KEYS = ["phase", "task", "pr", "sha", "merged_at", "files"];
const SHA_RE = /^[0-9a-f]{7,40}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ---------- Parser ----------

export function parseManifestBlock(planSource) {
  const loc = locateManifestYaml(planSource);
  if (!loc.sectionFound) return { ok: false, reason: "no_section" };
  if (!loc.fenceFound) return { ok: false, reason: "no_yaml_fence" };
  return parseYaml(loc.yaml);
}

function locateManifestYaml(planSource) {
  const lines = planSource.split("\n");
  let sectionStart = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === MANIFEST_SECTION_HEADING) {
      sectionStart = i;
      break;
    }
  }
  if (sectionStart < 0) return { sectionFound: false, fenceFound: false, yaml: "" };
  // The subsection runs until the next `## ` (parent break) or `### `
  // (sibling subsection like `### Notes`). Bare `##` / `###` (no trailing
  // space) is not a heading per CommonMark, so the trailing-space match
  // is intentional.
  let sectionEnd = lines.length;
  for (let i = sectionStart + 1; i < lines.length; i++) {
    if (/^## |^### /.test(lines[i])) {
      sectionEnd = i;
      break;
    }
  }
  let fenceStart = -1;
  for (let i = sectionStart + 1; i < sectionEnd; i++) {
    if (/^```ya?ml\s*$/.test(lines[i].trim())) {
      fenceStart = i;
      break;
    }
  }
  if (fenceStart < 0) return { sectionFound: true, fenceFound: false, yaml: "" };
  let fenceEnd = -1;
  for (let i = fenceStart + 1; i < sectionEnd; i++) {
    if (lines[i].trim() === "```") {
      fenceEnd = i;
      break;
    }
  }
  if (fenceEnd < 0) return { sectionFound: true, fenceFound: false, yaml: "" };
  return {
    sectionFound: true,
    fenceFound: true,
    yaml: lines.slice(fenceStart + 1, fenceEnd).join("\n"),
    fenceStart,
    fenceEnd,
  };
}

function parseYaml(yamlSource) {
  const lines = yamlSource.split("\n");
  let version = null;
  const shipped = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlankOrComment(line)) {
      i++;
      continue;
    }
    const versionMatch = line.match(/^manifest_schema_version:\s*(\d+)\s*(?:#.*)?$/);
    if (versionMatch) {
      version = Number(versionMatch[1]);
      i++;
      continue;
    }
    if (/^shipped:\s*\[\s*\]\s*(?:#.*)?$/.test(line)) {
      i++;
      continue;
    }
    if (/^shipped:\s*(?:#.*)?$/.test(line)) {
      i++;
      const result = parseShippedEntries(lines, i);
      shipped.push(...result.entries);
      i = result.next;
      continue;
    }
    // Unknown top-level key — skip.
    i++;
  }
  if (version === null) return { ok: false, reason: "missing_schema_version" };
  return { ok: true, version, shipped };
}

function parseShippedEntries(lines, start) {
  const entries = [];
  let i = start;
  while (i < lines.length) {
    if (isBlankOrComment(lines[i])) {
      i++;
      continue;
    }
    // Top-level key (column 0 non-space) ends the shipped list.
    if (/^\S/.test(lines[i])) break;
    const entryMatch = lines[i].match(/^(\s*)-\s+(.*)$/);
    if (!entryMatch) {
      i++;
      continue;
    }
    const baseIndent = entryMatch[1].length;
    const fieldIndent = baseIndent + 2;
    const entry = {};
    const firstField = parseFieldLine(entryMatch[2]);
    if (firstField) {
      const result = applyField(entry, firstField, lines, i + 1, fieldIndent);
      i = result.next;
    } else {
      i++;
    }
    while (i < lines.length) {
      if (isBlankOrComment(lines[i])) {
        i++;
        continue;
      }
      const lineIndent = lines[i].match(/^(\s*)/)[0].length;
      // De-indent below fieldIndent ends this entry. A `- ` at baseIndent
      // (fieldIndent − 2) starts the next entry; let the outer loop pick
      // it up.
      if (lineIndent < fieldIndent) break;
      const fieldText = lines[i].slice(fieldIndent);
      const field = parseFieldLine(fieldText);
      if (!field) {
        i++;
        continue;
      }
      const result = applyField(entry, field, lines, i + 1, fieldIndent);
      i = result.next;
    }
    entries.push(entry);
  }
  return { entries, next: i };
}

function parseFieldLine(text) {
  const m = text.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/);
  if (!m) return null;
  return { key: m[1], rawValue: m[2].replace(/\s*#.*$/, "").trim() };
}

function applyField(entry, field, lines, nextI, fieldIndent) {
  const { key, rawValue } = field;
  if (rawValue === "") {
    // Nested block: child list or sub-mapping. We only encounter the list
    // form in this schema (e.g., `files:` followed by `- path/to/file`).
    let i = nextI;
    const childLines = [];
    while (i < lines.length) {
      if (/^\s*$/.test(lines[i])) {
        childLines.push("");
        i++;
        continue;
      }
      const childIndent = lines[i].match(/^(\s*)/)[0].length;
      if (childIndent <= fieldIndent) break;
      childLines.push(lines[i]);
      i++;
    }
    entry[key] = parseChildBlock(childLines);
    return { next: i };
  }
  if (rawValue === "|" || rawValue === "|+" || rawValue === "|-") {
    let i = nextI;
    const childLines = [];
    let baseChildIndent = -1;
    while (i < lines.length) {
      if (/^\s*$/.test(lines[i])) {
        childLines.push("");
        i++;
        continue;
      }
      const childIndent = lines[i].match(/^(\s*)/)[0].length;
      if (childIndent <= fieldIndent) break;
      if (baseChildIndent < 0) baseChildIndent = childIndent;
      childLines.push(lines[i].slice(baseChildIndent));
      i++;
    }
    let text = childLines.join("\n");
    if (rawValue === "|" || rawValue === "|-") text = text.replace(/\n+$/, "");
    if (rawValue === "|") text += "\n";
    entry[key] = text;
    return { next: i };
  }
  entry[key] = parseInlineScalar(rawValue);
  return { next: nextI };
}

function parseChildBlock(lines) {
  const nonBlank = lines.filter((l) => !/^\s*$/.test(l));
  if (nonBlank.length === 0) return "";
  const firstTrim = nonBlank[0].trim();
  // Block-list form: `- item` per indented line.
  if (/^-\s/.test(firstTrim)) {
    const out = [];
    for (const l of nonBlank) {
      const m = l.match(/^\s*-\s+(.*)$/);
      if (m) out.push(parseInlineScalar(m[1].replace(/\s*#.*$/, "").trim()));
    }
    return out;
  }
  // Multi-line indented flow-array form, used by Plan-007's backfilled manifest:
  //   spec_coverage:
  //     [
  //       "Spec-007 §Wire Format",
  //       "Spec-007 §Required Behavior",
  //     ]
  // Pre-fix this fell through to the raw-string return path, then validateEntry
  // failed on `spec_coverage must be an array of strings`. Codex P2 finding on
  // PR #35 round 4. The join-on-space + splitFlowArray combination preserves
  // commas inside quoted elements (the round-3 fix).
  const lastTrim = nonBlank[nonBlank.length - 1].trim();
  if (firstTrim.startsWith("[") && lastTrim.endsWith("]")) {
    const joined = nonBlank.map((l) => l.trim()).join(" ");
    if (joined.startsWith("[") && joined.endsWith("]")) {
      const inner = joined.slice(1, -1).trim();
      if (inner === "") return [];
      return splitFlowArray(inner)
        .map((s) => s.trim())
        .filter((s) => s !== "")
        .map((s) => parseInlineScalar(s.replace(/\s*#.*$/, "").trim()));
    }
  }
  return lines.join("\n").replace(/\n+$/, "");
}

// Split a YAML flow-array body on top-level commas only — commas inside
// "..." or '...' are preserved as-is. The naive `inner.split(",")` corrupts
// quoted elements like "Spec-001 rows 4,5" by splitting them into two
// items (Codex P2 finding on PR #35 round 3). Escape sequences (\" inside
// double-quoted) are not handled — the manifest schema's quoted strings
// (spec_coverage / verifies_invariant cite text) do not use them today.
function splitFlowArray(inner) {
  const parts = [];
  let start = 0;
  let quote = null;
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ",") {
      parts.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(inner.slice(start));
  return parts;
}

function parseInlineScalar(raw) {
  if (raw === "") return "";
  if (/^"[^"]*"$|^'[^']*'$/.test(raw)) return raw.slice(1, -1);
  if (raw.startsWith("[") && raw.endsWith("]")) {
    const inner = raw.slice(1, -1).trim();
    if (inner === "") return [];
    return splitFlowArray(inner).map((s) => parseInlineScalar(s.trim()));
  }
  if (/^-?\d+$/.test(raw)) return Number(raw);
  if (/^-?\d+\.\d+$/.test(raw)) return Number(raw);
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "null" || raw === "~") return null;
  return raw;
}

function isBlankOrComment(line) {
  return /^\s*$/.test(line) || /^\s*#/.test(line);
}

// ---------- Validator ----------

export function validateEntry(entry) {
  const errors = [];
  if (!entry || typeof entry !== "object") {
    return { ok: false, errors: ["entry must be an object"] };
  }
  for (const k of Object.keys(entry)) {
    if (!ENTRY_KEYS.has(k)) errors.push(`unknown field: ${k}`);
  }
  for (const k of REQUIRED_KEYS) {
    if (!(k in entry)) errors.push(`missing required field: ${k}`);
  }
  if (!Number.isInteger(entry.phase) || entry.phase < 1) {
    errors.push("phase must be a positive integer");
  }
  if (typeof entry.task === "string") {
    if (entry.task.trim() === "") errors.push("task must be non-empty");
  } else if (Array.isArray(entry.task)) {
    if (entry.task.length === 0) {
      errors.push("task array must be non-empty");
    } else if (!entry.task.every((t) => typeof t === "string" && t.trim() !== "")) {
      errors.push("task array items must be non-empty strings");
    }
  } else {
    errors.push("task must be a non-empty string or non-empty string[]");
  }
  if (!Number.isInteger(entry.pr) || entry.pr < 1) {
    errors.push("pr must be a positive integer");
  }
  if (typeof entry.sha !== "string" || !SHA_RE.test(entry.sha)) {
    errors.push("sha must be a hex string of 7-40 chars");
  }
  if (typeof entry.merged_at !== "string" || !DATE_RE.test(entry.merged_at)) {
    errors.push("merged_at must be a YYYY-MM-DD string");
  }
  if (!Array.isArray(entry.files)) {
    errors.push("files must be an array of path strings");
  } else if (!entry.files.every((f) => typeof f === "string" && f.trim() !== "")) {
    errors.push("files entries must be non-empty strings");
  }
  if (entry.verifies_invariant !== undefined) {
    if (
      !Array.isArray(entry.verifies_invariant) ||
      !entry.verifies_invariant.every((s) => typeof s === "string")
    ) {
      errors.push("verifies_invariant must be an array of strings");
    }
  }
  if (entry.spec_coverage !== undefined) {
    if (
      !Array.isArray(entry.spec_coverage) ||
      !entry.spec_coverage.every((s) => typeof s === "string")
    ) {
      errors.push("spec_coverage must be an array of strings");
    }
  }
  if (entry.notes !== undefined && typeof entry.notes !== "string") {
    errors.push("notes must be a string");
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

// ---------- Append (idempotent on `pr`) ----------

export function appendManifestEntry(planSource, entry) {
  const parseResult = parseManifestBlock(planSource);
  if (!parseResult.ok) {
    throw new Error(`cannot append: manifest block invalid (${parseResult.reason})`);
  }
  const validation = validateEntry(entry);
  if (!validation.ok) {
    throw new Error(`cannot append: invalid entry (${validation.errors.join("; ")})`);
  }
  if (parseResult.shipped.some((e) => e.pr === entry.pr)) {
    return planSource;
  }
  const lines = planSource.split("\n");
  const loc = locateManifestYaml(planSource);
  const yamlLines = lines.slice(loc.fenceStart + 1, loc.fenceEnd);
  const newYamlLines = injectEntry(yamlLines, entry);
  return [
    ...lines.slice(0, loc.fenceStart + 1),
    ...newYamlLines,
    ...lines.slice(loc.fenceEnd),
  ].join("\n");
}

function injectEntry(yamlLines, entry) {
  const serialized = serializeEntry(entry);
  let shippedIdx = -1;
  for (let i = 0; i < yamlLines.length; i++) {
    if (/^shipped:/.test(yamlLines[i])) {
      shippedIdx = i;
      break;
    }
  }
  if (shippedIdx < 0) throw new Error("manifest YAML missing `shipped:` key");
  if (/^shipped:\s*\[\s*\]/.test(yamlLines[shippedIdx])) {
    return [
      ...yamlLines.slice(0, shippedIdx),
      "shipped:",
      ...serialized,
      ...yamlLines.slice(shippedIdx + 1),
    ];
  }
  // Non-empty list: append after the last indented non-comment line so
  // illustrative trailing comments stay at the bottom of the block.
  let lastEntryEnd = shippedIdx;
  for (let i = shippedIdx + 1; i < yamlLines.length; i++) {
    const line = yamlLines[i];
    if (/^\S/.test(line)) break;
    if (/^\s*$/.test(line)) continue;
    if (/^\s*#/.test(line)) continue;
    lastEntryEnd = i;
  }
  return [
    ...yamlLines.slice(0, lastEntryEnd + 1),
    ...serialized,
    ...yamlLines.slice(lastEntryEnd + 1),
  ];
}

export function serializeEntry(entry) {
  const out = [];
  out.push(`  - phase: ${entry.phase}`);
  if (Array.isArray(entry.task)) {
    out.push(`    task: [${entry.task.join(", ")}]`);
  } else {
    out.push(`    task: ${entry.task}`);
  }
  out.push(`    pr: ${entry.pr}`);
  out.push(`    sha: ${entry.sha}`);
  out.push(`    merged_at: ${entry.merged_at}`);
  if (entry.files.length === 0) {
    out.push(`    files: []`);
  } else {
    out.push(`    files:`);
    for (const f of entry.files) out.push(`      - ${f}`);
  }
  out.push(`    verifies_invariant: [${(entry.verifies_invariant ?? []).join(", ")}]`);
  out.push(`    spec_coverage: [${(entry.spec_coverage ?? []).map(quoteIfNeeded).join(", ")}]`);
  if (entry.notes && entry.notes.trim() !== "") {
    out.push(`    notes: |`);
    for (const line of entry.notes.replace(/\n+$/, "").split("\n")) {
      out.push(`      ${line}`);
    }
  }
  return out;
}

function quoteIfNeeded(s) {
  // Spec-coverage values like "Spec-NNN row 4" contain spaces. Wrap such
  // values in double quotes when written as flow-array elements so the
  // re-parser can split-by-comma without losing the space-bearing token.
  if (/[\s,[\]{}]/.test(s)) return `"${s}"`;
  return s;
}
