// mermaid-set-coherence — narrow hard-signal hook against PR #27 round 2.
//
// Trigger condition (BOTH required in the same file):
//   1. A Mermaid graph block with class-decorated nodes (`Foo[label]:::ready`,
//      `:::blocked`, etc.) AND a `classDef <name> ...` line declaring the class.
//   2. A prose enumeration line of the shape:
//        `<adjective> set (X, Y, Z, ...) <verb> ...`
//      where the adjective matches a declared classDef name.
//
// Hard failure if the parenthesized identifier set does not equal the union
// of node IDs decorated with `:::<adjective>`.
//
// Doesn't catch (residuals, see failure-mode-catalog.md CAT-05 known gaps):
//   - Set claims expressed in tables / lists.
//   - Cross-file enumerations.
//   - Blockquoted mermaid graphs: fence tracking looks through `>` prefixes
//     (suppression of quoted examples works), but node collection and the
//     classDef scan read the RAW line, so a quoted graph stays illustrative —
//     never collected, never validated (Codex, PR #270 round 1; zero such
//     graphs in the tracked corpus). Validating them needs blockquote-depth
//     matching on BOTH the collection and enumeration sides — without it, a
//     quoted example's classDef would pollute the file-global class set.
//
// Content arrives through an injected FileContentReader (defaulting to a plain
// disk read): the pre-commit runner passes its commit-snapshot reader so the
// check validates the STAGED blob rather than the editor buffer.

import { readFileSync } from "node:fs";

import type { FileContentReader } from "./cite-target-existence.ts";
import { advanceScanState, INITIAL_SCAN_STATE, type MarkdownScanState } from "./markdown-fences.ts";

export interface MermaidViolation {
  file: string;
  line: number;
  className: string;
  prose: string[];
  graph: string[];
  missing: string[];
  extra: string[];
}

const ENUM_RE = /^.*?\b(?<adjective>[a-z]+) set \((?<list>[A-Za-z0-9,\- ]+)\)/i;

const readFromDisk: FileContentReader = (absolutePath) => readFileSync(absolutePath, "utf8");

// A fence whose info string names mermaid. Read from the INFO STRING the
// tracker returns, never re-matched against the raw line: restating the
// delimiter prefix here meant restating its indentation budget too, and once
// the tracker measured that budget from a list container's content column
// (task #83) a valid `10. `-nested ```mermaid opener passed the tracker and
// failed this regex — the fence opened, the graph went uncollected. The
// refinement now decides only WHICH kind of fence opened, which is all it was
// ever meant to decide.
const MERMAID_INFO_STRING_RE = /^[ \t]*mermaid\b/;

export function parseFile(
  filePath: string,
  readContent: FileContentReader = readFromDisk,
): MermaidViolation[] {
  const content = readContent(filePath);
  const violations: MermaidViolation[] = [];

  const classDefLines = [...content.matchAll(/^\s*classDef\s+(\w+)\b/gm)];
  if (classDefLines.length === 0) return [];
  const declaredClasses = new Set(classDefLines.map((m) => m[1]));

  // One shared-tracker walk feeds both scans: node collection (inside mermaid
  // fences only) and the `fenced` lookup the enumeration scan consults. The
  // private toggles this replaces closed a fence on ANY same-marker line, so an
  // info-string'd inner delimiter ended suppression early and prose below it
  // was scanned as live enumeration; they also opened fences on indented code
  // (4+ spaces) and never looked through blockquote containers. Delimiter lines
  // count as fenced, matching the old `continue` on both fence boundaries.
  // Blockquote stripping here serves fence TRACKING (suppressing quoted
  // examples); the node matcher below and the classDef scan above read the
  // RAW line by design, so a graph inside a blockquote is illustrative, not
  // validated — see the header residuals.
  const nodeIdsByClass = new Map<string, Set<string>>();
  const lines = content.split("\n");
  const fenced = new Array<boolean>(lines.length).fill(false);
  let scanState: MarkdownScanState = INITIAL_SCAN_STATE;
  let inMermaidFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const stepped = advanceScanState(line, scanState);
    fenced[i] = stepped.openFenceAtLineStart !== null || stepped.isDelimiterLine;
    if (stepped.openFenceAtLineStart === null && stepped.state.openFence !== null) {
      inMermaidFence = MERMAID_INFO_STRING_RE.test(stepped.state.openFence.infoString);
    } else if (stepped.state.openFence === null) {
      inMermaidFence = false;
    }
    const isMermaidContent =
      stepped.openFenceAtLineStart !== null && stepped.state.openFence !== null && inMermaidFence;
    scanState = stepped.state;
    if (!isMermaidContent) continue;
    const m = /^\s*(\w+)\s*\[[^\]]*\]\s*:::\s*(\w+)/.exec(line);
    if (!m) continue;
    const [, nodeId, className] = m;
    if (!declaredClasses.has(className)) continue;
    if (!nodeIdsByClass.has(className)) nodeIdsByClass.set(className, new Set());
    nodeIdsByClass.get(className)!.add(nodeId);
  }

  if (nodeIdsByClass.size === 0) return [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (fenced[i]) continue;
    const m = ENUM_RE.exec(line);
    if (!m) continue;
    const adjective = (m.groups!.adjective || "").toLowerCase();
    const proseList = m
      .groups!.list.split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    if (!declaredClasses.has(adjective)) continue;

    const graphSet = nodeIdsByClass.get(adjective) ?? new Set<string>();
    const normalize = (s: string) => s.replace(/-/g, "").toUpperCase();
    const proseSet = new Set(proseList.map(normalize));
    const graphNorm = new Set(Array.from(graphSet).map(normalize));

    const missing = [...proseSet].filter((x) => !graphNorm.has(x));
    const extra = [...graphNorm].filter((x) => !proseSet.has(x));
    if (missing.length === 0 && extra.length === 0) continue;

    violations.push({
      file: filePath,
      line: i + 1,
      className: adjective,
      prose: proseList,
      graph: [...graphSet],
      missing,
      extra,
    });
  }

  return violations;
}

export function checkMermaidSetCoherence(
  files: string[],
  readContent: FileContentReader = readFromDisk,
): MermaidViolation[] {
  const violations: MermaidViolation[] = [];
  for (const f of files) {
    violations.push(...parseFile(f, readContent));
  }
  return violations;
}

export function formatMermaidViolations(violations: MermaidViolation[]): string {
  if (violations.length === 0) return "";
  const lines: string[] = [];
  for (const v of violations) {
    lines.push(
      `mermaid-set-coherence: ${v.file}:${v.line} — "${v.className} set" prose enumeration vs graph :::${v.className} mismatch`,
    );
    lines.push(`  prose: (${v.prose.join(", ")})`);
    lines.push(`  graph: (${v.graph.join(", ")})`);
    if (v.missing.length) lines.push(`  in prose but not graph: ${v.missing.join(", ")}`);
    if (v.extra.length) lines.push(`  in graph but not prose: ${v.extra.join(", ")}`);
  }
  lines.push("");
  lines.push(
    `mermaid-set-coherence: ${violations.length} violation(s). Re-derive the prose enumeration from the graph (or vice-versa) and re-stage.`,
  );
  return lines.join("\n");
}
