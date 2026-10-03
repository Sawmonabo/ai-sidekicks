// The command line one app launch is given, and the graphics stack it names.
//
// Every switch the harness passes is decided here.
//
// The harness supplies the graphics stack, not the CI job: `_electron.launch` takes an executable
// path, not a shell command, so no `xvfb-run`-style wrapper can inject switches, and the job's
// Xvfb provides a DISPLAY, not a GL driver (a hosted runner has no GPU). A switch written into the
// workflow would make CI and a developer's headless container two different applications.
//
// Both launching tiers get one command line: the endurance `terminal-instance-memory` row needs a
// live WebGL2 context and refuses a fallback-renderer reading
// (`endurance/terminal-pane-harness.ts`), and the end-to-end tier proves the application that row
// is measured against.

import process from "node:process";

/** The platform a launch resolves its graphics stack for. */
export type LaunchPlatform = typeof process.platform;

/**
 * The Chromium precise-heap switch. At Blink's default precision `usedJSHeapSize` is quantized
 * and served from a long-interval cache, which is useless for gated figures that are differences
 * of two readings seconds apart. Off unless a launch asks, since it makes every read walk the heap.
 */
const PRECISE_MEMORY_INFO_FLAG = "--enable-precise-memory-info";

/**
 * The switches that put a GPU-less host's renderer on a real WebGL2 context.
 *
 * SwANGLE (ANGLE over SwiftShader's CPU Vulkan) is the driver Chromium's own GPU-less bots run;
 * `--use-gl=angle --use-angle=swiftshader` select it. `--enable-unsafe-swiftshader` is the opt-in
 * Chromium's documentation requires wherever SwiftShader backs WebGL: automatic fallback to it is
 * deprecated and context creation now fails, which the ubuntu runner reported as a `dom` reading.
 * It is inert where hardware GL exists (alone on macOS it still reports the Metal renderer).
 *
 * It moves no heap figure, since `usedJSHeapSize` counts the V8 heap, not a rasterizer's store.
 * It can move wall-time bounds: a CPU rasterizer starts the GPU process and paints on a different
 * schedule, so a red `launch-*` or `endurance-body` check on Linux is a candidate
 * to weigh. The frame-paint probe fails only on a frame that never arrives, so a slower paint
 * passes it silently; the frame interval `launch-readiness.ts` prints on every launch is the
 * evidence to read.
 */
const SOFTWARE_GRAPHICS_SWITCHES: readonly string[] = [
  "--use-gl=angle",
  "--use-angle=swiftshader",
  "--enable-unsafe-swiftshader",
];

/**
 * The platforms a launch supplies its own software GL on: Linux only, and measured. On macOS the
 * same switches take WebGL2 away: SwiftShader's Vulkan ICD does not initialize on this Electron's
 * darwin-arm64 build, and every spelling tried (`swiftshader`, `swiftshader-webgl`,
 * `--disable-gpu` with the opt-in) leaves the GPU process dead with `eglInitialize SwANGLE
 * failed` and no WebGL2, so the platform test is load-bearing. The hosted Linux runner has no
 * GPU, while macOS and Windows hosts carry a GL of their own.
 */
const SOFTWARE_GRAPHICS_PLATFORMS: readonly LaunchPlatform[] = ["linux"];

/** The graphics switches `platform` needs, which is none where the host has GL. */
function softwareGraphicsSwitchesFor(platform: LaunchPlatform): readonly string[] {
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
  /** The fixture scenario the app plays, or `undefined` for a normal launch. */
  readonly fixtureScenarioId?: string;
}

/**
 * The whole `args` array for one launch, in the order Electron receives it.
 *
 * A fresh, mutable array every call: `_electron.launch` declares `args` mutable, and a shared
 * array would leak one launch's switches into the next. The profile comes first and the entry
 * path after the switches; the order is legibility (Chromium's `base::CommandLine` lets the last
 * duplicate win, measured). The protection is that no switch repeats `--user-data-dir`, whose
 * loss puts the launch back on Electron's machine-wide `SingletonLock`, so it quits before
 * opening a window.
 */
export function composeLaunchArgs(options: LaunchArgsOptions): string[] {
  return [
    `--user-data-dir=${options.profileDirectory}`,
    ...softwareGraphicsSwitchesFor(options.platform),
    ...(options.isPreciseHeapReadingRequired ? [PRECISE_MEMORY_INFO_FLAG] : []),
    options.mainEntryPath,
    // The application's own arguments follow the entry path, where the main process reads them.
    ...(options.fixtureScenarioId === undefined ? [] : ["--fixture", options.fixtureScenarioId]),
  ];
}
