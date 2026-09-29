// Where the session-surfaces family's two subtrees are composed in, and nothing else.
//
// The all-sessions destination and the settings frame are two view families, and a view
// family may name no other (`console-view-family-isolation` in `.dependency-cruiser.mjs`).
// A file directly under `console/` is a composition site, so naming both here is allowed
// and each subtree's own door names only itself.
//
// No logic lands here, and no subtree registers itself at module scope: each registrar
// takes the registry it is handed, so a test composes this family into a registry it owns.

import type { ConsoleSurfaceRegistry } from "./seats/index.js";
import { registerSessionsSurface } from "@renderer/features/sessions/contributions/screens.js";
import { registerSettingsSurface } from "./settings/index.js";

/**
 * Claim every surface slot this family owns.
 *
 * The surface board is HANDED to this function rather than reached for, for
 * `registerConsoleFamilies`' reason. The second argument is a COMPOSITION rather than a
 * board, on the terms `families.ts` names one under: the sessions destination offers a
 * composed draft beside the shipped probe, and that control is the workspace family's —
 * a view family this one may not import — so the root names which component fills the
 * place and this file hands it on.
 */
export function registerSessionSurfacesFamily(surfaces: ConsoleSurfaceRegistry): void {
  registerSessionsSurface(surfaces);
  registerSettingsSurface(surfaces);
}
