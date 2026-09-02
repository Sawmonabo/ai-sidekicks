// The workspace family's door.
//
// The family holds the session workspace's shared vocabulary — today, the seats
// through which the six view families hand each other panes, a composer, sidebar
// sections, timeline rows, and inline cards. A barrel and nothing else: the
// declarations live in `seats/`, which has its own barrel because a caller
// reaching for a seat is reaching for the seam and should say so in the import
// path.
//
// The family sits above `bridge/` and below the view families in the console's
// DAG, and it imports nothing from `frame/` or `palette/` — a seat that needed the
// frame would be a mount rather than a seam.

export * from "./seats/index.js";

// The session sidebar's frame. It is the composer family's body, and the workspace
// family's door is where it belongs: the sidebar renders sections four families
// own, so a consumer reaching it through a view family's barrel would acquire an
// edge to a sibling.
//
// The dead-code exemption rides EVERY hop of the re-export, this one and the
// sidebar's own barrel: knip reports the unconsumed export at whichever specifier
// is the last one nothing reads through, so a tag on one hop alone moves the
// finding rather than answering it. Both are deleted by the task that imports the
// symbol.
export {
  /** @consumedBy T-023p-1C-2 */
  Sidebar,
  /** @consumedBy T-023p-1C-2 */
  type SidebarProps,
} from "./sidebar/index.js";
