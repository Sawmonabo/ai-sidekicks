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
