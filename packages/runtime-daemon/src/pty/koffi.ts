// Loads `koffi`, the library that calls the operating system's own functions where Node offers no
// call of its own. It is loaded only when a caller first needs it, through a specifier in a
// variable, so a system whose code never calls it never loads its native binding.

import type KoffiModule from "koffi";

/** The `koffi` module. */
export type Koffi = typeof KoffiModule;

/**
 * Loads `koffi`, throwing with an install hint that names `neededFor` when it cannot be loaded,
 * so the failure is loud where the system call is needed.
 */
export async function importKoffi(neededFor: string): Promise<Koffi> {
  const specifier: string = "koffi";
  let imported: { default?: Koffi; load?: unknown };
  try {
    imported = (await import(specifier)) as { default?: Koffi; load?: unknown };
  } catch (cause) {
    throw new Error(
      `\`koffi\` is required for ${neededFor} but could not be loaded. Reinstall the ` +
        "package's dependencies with `pnpm install`.",
      { cause },
    );
  }
  // An ES module bridge of a CommonJS package may carry the binding on `default` alone.
  const koffi = imported.default ?? imported;
  if (typeof koffi.load !== "function") {
    throw new Error(
      "The installed `koffi` exposes no `load` function as a default or named export; its " +
        "module shape changed, so pin the dependency or update this loader.",
    );
  }
  return koffi as Koffi;
}
