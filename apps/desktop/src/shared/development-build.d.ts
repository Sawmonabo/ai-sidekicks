// Vite's own build signals, which main and the renderer both read. Vite substitutes each member
// with a literal at build time, so a branch on one is folded out of every build it is false in.

interface ImportMetaEnv {
  /** Vite's development-mode flag: `true` only under `electron-vite dev`. */
  readonly DEV: boolean;
  /** Vite's production-mode flag. */
  readonly PROD: boolean;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
