// The file name a program built for this package has on each operating system.

/** The file name of the program `base` on `platform`: with `.exe` on Windows, as it is elsewhere. */
export function executableFileName(base: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? `${base}.exe` : base;
}
