// The settings family's closed vocabulary: which sections exist, and what the rail calls
// them.
//
// A LEAF, AND THAT IS WHAT IT IS FOR. This was declared at the top of
// `settings-page-registry.ts` while the registry was the only module that needed it before
// its own consumers did. It stopped being true when the page registry grew a loader arm:
// the reserved region a loader-backed page renders while its chunk arrives names the
// section it is waiting on, so the component the registry constructs needs the section
// type the registry declares, and `PendingSettingsPageBody → settings-page-registry →
// PendingSettingsPageBody` is a cycle `no-circular` fails. That rule's own remedy is the
// hoist rather than a weakened type, and this is the lowest home both sides can read: a
// vocabulary and nothing else, importing nothing.
//
// Nothing here is a wire shape. A section id names a rail entry and a `#/settings/<page>`
// address segment, both of which are this renderer's own; the daemon is asked nothing
// about them, which is why the console may decide one.

/**
 * Every settings section, in rail order.
 *
 * The twelve the design enumerates, in its order, plus `sidekicks` and `daemon`. The
 * rail a person reads is this tuple, and the union is derived from it for the reason
 * `seats/surface-registry.ts` gives about its own slots: a union written beside a
 * hand-repeated array is two closed sets that agree until one of them is widened.
 *
 * `sidekicks` and `daemon` are the two ids that are this console's own rather than
 * the design's. The design puts the saved-sidekick page IN settings and reaches it
 * from the in-session attach picker, but its section enumeration names no id for it,
 * so a page that exists and a rail that cannot reach it was the alternative. An id
 * carries no wire and asserts nothing about the daemon, which is why it can be
 * decided here; a PAGE with no body still could not be, and both of these have one.
 */
export const SETTINGS_SECTION_IDS = [
  "accounts",
  "mcp-servers",
  "sidekicks",
  "cost",
  "nodes",
  "notifications",
  "keyboard",
  "appearance",
  "mounts",
  "diagnostics",
  "data",
  "application",
  "browser",
  // The local runtime's own page, which is §Tray and daemon lifecycle's "one click
  // away": the supervisor detail, its attempt count and last heartbeat, and the stop
  // and restart controls. Like `sidekicks` it is not one of the design's section ids
  // — the design puts this detail one click behind the frame's chip and names no
  // section for it — and the alternative was a chip that claims a detail view nothing
  // can reach.
  "daemon",
] as const;

/** One settings section. Derived from the enumeration, never restated. */
export type SettingsSectionId = (typeof SETTINGS_SECTION_IDS)[number];

/**
 * The rail's label for each section, in one place.
 *
 * A TOTAL record, so a fifteenth section is a compile error here until its label
 * is decided — the label cannot silently default to the id, which is how a rail
 * grows an entry reading `mcp-servers`.
 */
export const SETTINGS_SECTION_LABELS: Readonly<Record<SettingsSectionId, string>> = {
  accounts: "Accounts",
  "mcp-servers": "MCP servers",
  sidekicks: "Sidekicks",
  cost: "Cost",
  nodes: "Nodes",
  notifications: "Notifications",
  keyboard: "Keyboard",
  appearance: "Appearance",
  mounts: "Mounts",
  diagnostics: "Diagnostics",
  data: "Data",
  application: "Application",
  browser: "Browser",
  daemon: "Local runtime",
};
