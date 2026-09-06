// The command line one console launch is given, and the graphics stack it names.
//
// Split out of `electron-harness.ts` for the reason `launch-profile.ts` and
// `launch-body.ts` were: the property worth checking here is a property of an
// ARRAY, and reaching it through the launcher would mean starting a real Electron
// to assert on a string. Every switch the harness passes is decided here, and the
// launcher spells none of its own — `launch-args.test.ts` fails a launcher that
// does, which is the shape that let the last defect through.
//
// WHY THE HARNESS SUPPLIES THE GRAPHICS STACK AND NOT THE CI JOB
//
// `_electron.launch` takes an executable path, not a shell command, so there is no
// `xvfb-run`-style wrapper a job could inject switches through: whatever GL the
// renderer gets has to be stated in the array below or it is not stated at all.
// The tier-1 job stands up one Xvfb and exports `$DISPLAY`, which is a DISPLAY and
// not a GL driver — a hosted runner has no GPU and no DRI device behind that
// socket. And a switch written into the workflow instead would make CI and a
// developer's headless container two different applications, which is the drift
// the shared launcher exists to prevent.
//
// The two launching tiers therefore get one command line. The endurance tier's
// `terminal-instance-memory` row bounds a whole pane on a live WebGL2 context and
// fails on a fallback-renderer reading (`apps/desktop/AGENTS.md`, and the refusal
// in `endurance/terminal-pane-harness.ts`), and the end-to-end tier proves the
// application that row is measured against — a tier-scoped switch would mean the
// two drove different renderers, which is the case `electron-harness.ts` opens by
// saying it exists to stop.

import process from "node:process";

/** The platform a launch resolves its graphics stack for. */
export type LaunchPlatform = typeof process.platform;

/**
 * What Chromium calls the precise-heap switch.
 *
 * At Blink's default precision `usedJSHeapSize` is quantized into buckets and
 * served from a long-interval cache rather than read when it is asked for, which
 * is useless for a tier whose gated figures are differences of two readings taken
 * seconds apart. Off unless a launch asks: the switch makes every read walk the
 * heap, a cost no tier that measures none should pay.
 */
const PRECISE_MEMORY_INFO_FLAG = "--enable-precise-memory-info";

/**
 * The switches that put a GPU-less host's renderer on a real WebGL2 context.
 *
 * SwANGLE — ANGLE over SwiftShader's CPU Vulkan implementation — is the driver
 * Chromium's own GPU-less bots run, and the first two switches are how its
 * documentation spells that selection: "As the OpenGL ES driver, SwANGLE (ANGLE +
 * SwiftShader Vulkan): `--use-gl=angle --use-angle=swiftshader`". The third is the
 * opt-in that same document requires wherever SwiftShader ends up backing WebGL,
 * automatic fallback to it having been deprecated so context creation now FAILS
 * instead — which is exactly what the ubuntu runner was reporting: a `dom`
 * reading, from a pane whose WebGL2 context could not be created at all.
 *
 * The opt-in is carried beside the driver selection rather than instead of it
 * because the two answer different questions — which driver, and whether WebGL may
 * be served from it — and only one of the two classifications Chromium can put
 * that driver in needs the second. Supplying it makes both work; withholding it
 * makes one of them fail, and it is measurably inert where hardware GL exists
 * (`--enable-unsafe-swiftshader` alone on this Mac still reports the Metal
 * renderer).
 *
 * It moves no figure either tier gates on. Both read `usedJSHeapSize`, which
 * counts the V8 JS heap and not a rasterizer's backing store, so what changes is
 * that the context EXISTS — not what the heap under it measures.
 */
export const SOFTWARE_GRAPHICS_SWITCHES: readonly string[] = [
  "--use-gl=angle",
  "--use-angle=swiftshader",
  "--enable-unsafe-swiftshader",
];

/**
 * The platforms a launch supplies its own software GL on.
 *
 * Linux only, and MEASURED rather than assumed in either direction. On macOS the
 * same three switches take WebGL2 away instead of supplying it: SwiftShader's
 * Vulkan ICD does not initialize on this Electron's darwin-arm64 build, and every
 * spelling of the selection — `swiftshader`, `swiftshader-webgl`, and
 * `--disable-gpu` with the opt-in — leaves the GPU process dead with
 * `eglInitialize SwANGLE failed` and the renderer with no WebGL2 at all, where the
 * unswitched launch reports the ANGLE Metal renderer. So this is not a switch set
 * that is merely unnecessary off Linux; it is one that breaks the thing it exists
 * to guarantee, and the platform test is load-bearing.
 *
 * Linux is also the only platform where the absence is not hypothetical: the
 * hosted runner has no GPU, and macOS and Windows hosts carry a GL implementation
 * of their own that the tiers should be measured against.
 */
const SOFTWARE_GRAPHICS_PLATFORMS: readonly LaunchPlatform[] = ["linux"];

/**
 * The graphics switches `platform` needs, which is none where the host has GL.
 */
export function softwareGraphicsSwitchesFor(platform: LaunchPlatform): readonly string[] {
  return SOFTWARE_GRAPHICS_PLATFORMS.includes(platform) ? SOFTWARE_GRAPHICS_SWITCHES : [];
}

/** What one launch needs said about it before Electron is spawned. */
export interface LaunchArgsOptions {
  /** This launch's private profile, which nothing may displace. */
  readonly profileDirectory: string;
  /** The built main entry Electron runs — the one positional argument. */
  readonly mainEntryPath: string;
  /** Whether this launch measures a heap and so needs the unbucketized instrument. */
  readonly isPreciseHeapReadingRequired: boolean;
  /** The host being launched on, which decides the graphics stack. */
  readonly platform: LaunchPlatform;
}

/**
 * The whole `args` array for one launch, in the order Electron receives it.
 *
 * A fresh array every call, never a shared one appended to: two launches that
 * mutated one array would give the second launch the first's switches, and the
 * case is cheap to hold open here and impossible to see at the call site. Mutable
 * because `_electron.launch` declares `args` as one, and handing it a `readonly`
 * array would cost a copy at the only call site that exists.
 *
 * The profile comes first and the entry path last. That ordering is legibility
 * rather than protection — Chromium's `base::CommandLine` assigns each switch as
 * it parses, so the LAST duplicate wins, measured on a real launch — and the
 * protection is that no switch below repeats `--user-data-dir`, which is the one
 * argument whose loss puts the launch back on Electron's machine-wide
 * `SingletonLock` and makes it quit before opening a window.
 */
export function composeLaunchArgs(options: LaunchArgsOptions): string[] {
  return [
    `--user-data-dir=${options.profileDirectory}`,
    ...softwareGraphicsSwitchesFor(options.platform),
    ...(options.isPreciseHeapReadingRequired ? [PRECISE_MEMORY_INFO_FLAG] : []),
    options.mainEntryPath,
  ];
}
