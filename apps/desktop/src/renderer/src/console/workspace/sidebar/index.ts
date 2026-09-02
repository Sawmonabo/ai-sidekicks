// The sidebar's door.
//
// One export: the frame. The sections are four families' bodies and reach it
// through `workspace/seats/sidebar-sections.ts`, so nothing here re-exports a body
// and no consumer of the sidebar acquires an edge to a section's owner.
//
// It lives inside the `workspace/` family rather than in a view family of its own
// because the workspace is where the seats live, and a sidebar that sat above them
// would be a seventh view family that four others had to import.

// The tags are the dead-code gate's per-symbol exemption on the terms
// `apps/desktop/AGENTS.md` sets: the deck that mounts the sidebar has not landed,
// so each specifier names the task that will import it, and that task deletes the
// tag in the PR that does.
export {
  /** @consumedBy T-023p-1C-2 */
  Sidebar,
  /** @consumedBy T-023p-1C-2 */
  type SidebarProps,
} from "./Sidebar.js";
