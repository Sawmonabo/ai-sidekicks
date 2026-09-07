// Where the saved-sidekick registry page lives in settings, named once.
//
// THE SET IS THE SETTINGS FAMILY'S AND THIS IS ONE CLAIM ON IT.
// `settings/settings-sections.ts` declares the closed section vocabulary; what lives
// here is the agents family's claim on one of its ids, so the registration that files
// the claim and the in-session surface that links back to the page read one string
// rather than two that agree until one of them moves.
//
// CHECKED AT THE COMPOSITION ROOT AND NOT HERE. `console/sidekicks-settings-page.ts`
// hands this constant to a registrar that requires a `SettingsSectionId`, so an id
// that has left the settings vocabulary is a compile error in the one file where both
// families are legally in scope. A view family may not name the settings family's
// types at all — `console-view-family-isolation` in `.dependency-cruiser.mjs` — which
// is why the literal type below is as far as this file can go on its own.
//
// A LEAF ON PURPOSE. It imports nothing, so the composition root and the agent
// console's chunk root can both name it without either one pulling the settings page
// into its graph.

/** The settings section the saved-sidekick registry page is registered under. */
export const SIDEKICK_DEFINITIONS_SECTION = "sidekicks" as const;
