// The renderer bundle budgets, which size-limit holds the release build in `out/renderer` to. The
// files are the renderer's initial graph: no path pattern can tell a chunk the entry imports from a
// lazy one, so they are read off the bundler's chunk manifest; size-limit does the measuring.

import { basename } from "node:path";

import type { SizeLimitConfig } from "size-limit";

import { readInitialGraphOrFailLoudly } from "#test/budget/built-renderer-tree.ts";

const initialGraph = readInitialGraphOrFailLoudly();

/**
 * The Latin-1 splits of the app's faces, by the name each package gives the file. Every other split
 * carries a `unicode-range` and is fetched only when a page draws one of its characters, so these
 * are what a Latin-1 page can load at startup, whatever the build declares.
 */
const latin1FontFiles = initialGraph.fonts.filter((path) =>
  /-Latin1-[^/]*\.woff2$/u.test(basename(path)),
);
if (latin1FontFiles.length === 0) {
  throw new Error(
    "No Latin-1 font split is on the renderer's initial graph, so the startup fonts budget would " +
      "measure nothing. Check the split names `styles/typeface.ts` imports.",
  );
}

/** Every size budget, each a ceiling in SI kilobytes (1 kB is 1000 B). */
const sizeLimitConfig: SizeLimitConfig = [
  {
    // The product's ceiling for the initial bundle, a gzip figure with lazy chunks excluded.
    name: "Renderer initial code, gzip",
    path: initialGraph.code,
    gzip: true,
    limit: "450 kB",
  },
  {
    // The gzip ceiling's headroom carried over: the measured 268,179 B brotli scaled by 450 kB over
    // the measured 309,059 B gzip, rounded down, so both trip at about the same growth.
    name: "Renderer initial code, brotli",
    path: initialGraph.code,
    limit: "390 kB",
  },
  {
    // What a Latin-1 page loads, raw, since a `woff2` face is brotli-compressed already and
    // compressing it again buys nothing: the Latin-1 split of each family and style, 220,440 B,
    // italics included because a page that sets an italic run loads them. The ceiling leaves 5.2 %
    // for a re-subset or a version bump. Re-derive it when the faces change, never to pass a
    // failure.
    name: "Renderer startup fonts on a Latin-1 page, raw",
    path: latin1FontFiles,
    brotli: false,
    limit: "232 kB",
  },
];

export default sizeLimitConfig;
