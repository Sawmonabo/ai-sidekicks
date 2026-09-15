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
  // The marker character and length of the fence currently open, or null.
  // Toggling a single boolean on any fence line closes a `~~~` block at the
  // first ``` inside it, which then reads that block's example tables as live
  // markdown. A closing fence is the same character, at least as long as the
  // opener, and carries nothing after it.
  let openFence = null;
  let headerCells = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    // CommonMark allows at most three spaces before a fence; four make an
    // indented code block, which prettier keeps as one.
    const fence = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      const marker = fence[1][0];
      const length = fence[1].length;
      const rest = fence[2];
      if (openFence === null) {
        // An opening backtick fence's info string may not itself contain a
        // backtick, so `` ```a`b `` is a paragraph, not a fence.
        if (!(marker === "`" && rest.includes("`"))) {
          openFence = { marker, length };
          headerCells = null;
          continue;
        }
      } else if (marker === openFence.marker && length >= openFence.length && rest.trim() === "") {
        openFence = null;
        headerCells = null;
        continue;
      } else {
        // A fence line that does not close the open block is its content.
        continue;
      }
    }
    if (openFence !== null) continue;
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
