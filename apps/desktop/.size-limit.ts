// The renderer bundle budgets, which size-limit holds the release build in `out/renderer` to. The
// files are the renderer's initial graph: no path pattern can tell a chunk the entry imports from a
// lazy one, so they are read off the bundler's chunk manifest; size-limit does the measuring.

import type { SizeLimitConfig } from "size-limit";

import { readInitialGraphOrFailLoudly } from "#test/budget/built-renderer-tree.ts";

const initialGraph = readInitialGraphOrFailLoudly();

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
    // the measured 309,059 B gzip, rounded down, so both trip on the same growth.
    name: "Renderer initial code, brotli",
    path: initialGraph.code,
    limit: "390 kB",
  },
  {
    // Raw, since a `woff2` face is brotli-compressed already and compressing it again buys nothing.
    // The four faces measure 220,440 B. The ceiling leaves 5.2 % for a re-subset or a version bump
    // yet refuses a fifth face: the smallest either font package publishes is 13,300 B, which
    // brings the sum to 233,740 B. Re-derive it when the faces change, never to pass a failure.
    name: "Renderer initial fonts, raw",
    path: initialGraph.fonts,
    brotli: false,
    limit: "232 kB",
  },
];

export default sizeLimitConfig;
