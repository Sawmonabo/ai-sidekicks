#!/usr/bin/env node
// Flags any GitHub-flavored-markdown table row whose cell count differs from
// its header row. Fenced code blocks are skipped. Prettier reflows a short row
// into a format-stable wrong table and stays green, so this check reads the
// source, not the render.
import { readFileSync } from "node:fs";

function cellCount(line) {
  const inner = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return inner.split(/(?<!\\)\|/).length;
}

function checkFile(file) {
  // An unreadable input is a usage error (exit 2), not a bad table (exit 1),
  // so CI can tell a typo'd path from a real finding.
  let source;
  try {
    source = readFileSync(file, "utf8");
  } catch {
    process.stderr.write(`table-arity: cannot read ${file}\n`);
    process.exit(2);
  }
  const lines = source.split("\n");
  const problems = [];
  let inFence = false;
  let headerCells = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      headerCells = null;
      continue;
    }
    if (inFence) continue;
    const isRow = /^\s*\|.*\|\s*$/.test(line);
    if (!isRow) {
      headerCells = null;
      continue;
    }
    const next = lines[i + 1] ?? "";
    const nextIsDelimiter = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(next);
    if (headerCells === null && nextIsDelimiter) {
      headerCells = cellCount(line);
      i += 1; // skip the delimiter row
      continue;
    }
    if (headerCells !== null) {
      const found = cellCount(line);
      if (found !== headerCells) {
        problems.push(`${file}:${i + 1}: expected ${headerCells} cells, found ${found}`);
      }
    }
  }
  return problems;
}

const files = process.argv.slice(2);
if (files.length === 0) {
  process.stderr.write("usage: table-arity.mjs <file.md> [...]\n");
  process.exit(2);
}
const problems = files.flatMap(checkFile);
if (problems.length > 0) {
  process.stderr.write(`${problems.join("\n")}\n`);
  process.exit(1);
}
