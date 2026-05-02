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

import { readFileSync } from "node:fs";

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

export function parseFile(filePath: string): MermaidViolation[] {
  const content = readFileSync(filePath, "utf8");
  const violations: MermaidViolation[] = [];

  const classDefLines = [...content.matchAll(/^\s*classDef\s+(\w+)\b/gm)];
  if (classDefLines.length === 0) return [];
  const declaredClasses = new Set(classDefLines.map((m) => m[1]));

  const nodeIdsByClass = new Map<string, Set<string>>();
  let inMermaid = false;
  const lines = content.split("\n");
  for (const line of lines) {
    if (/^```mermaid\b/.test(line.trim())) {
      inMermaid = true;
      continue;
    }
    if (inMermaid && line.trim().startsWith("```")) {
      inMermaid = false;
      continue;
    }
    if (!inMermaid) continue;
    const m = /^\s*(\w+)\s*\[[^\]]*\]\s*:::\s*(\w+)/.exec(line);
    if (!m) continue;
    const [, nodeId, className] = m;
    if (!declaredClasses.has(className)) continue;
    if (!nodeIdsByClass.has(className)) nodeIdsByClass.set(className, new Set());
    nodeIdsByClass.get(className)!.add(nodeId);
  }

  if (nodeIdsByClass.size === 0) return [];

  let inAnyFence = false;
  let fenceMarker = "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trimStart();
    if (!inAnyFence && (t.startsWith("```") || t.startsWith("~~~"))) {
      inAnyFence = true;
      fenceMarker = t.startsWith("```") ? "```" : "~~~";
      continue;
    }
    if (inAnyFence) {
      if (t.startsWith(fenceMarker)) {
        inAnyFence = false;
        fenceMarker = "";
      }
      continue;
    }
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

export function checkMermaidSetCoherence(files: string[]): MermaidViolation[] {
  const violations: MermaidViolation[] = [];
  for (const f of files) {
    violations.push(...parseFile(f));
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
