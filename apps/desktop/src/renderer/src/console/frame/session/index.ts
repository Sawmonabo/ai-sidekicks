// The session plane behind the frame: which session this window holds, and the
// registry of per-session stores it holds them in.
//
// A SUB-MODULE DOOR, published to `frame/` alone. Two sibling modules earn it, both
// in `composition/`: `ConsoleFrame.tsx` mounts the active session beside the store
// registry, and `ContextPicker.tsx` reads the active one to offer the switch. That
// pair of edges is the whole reason this line exists.
//
// The event binder, the diagnostics handle and the unbound-session retry are
// deliberately absent. Their readers are inside this directory — and, for the
// handle, one fixture helper outside the console that reaches the declaring module
// directly — so a line for any of them would publish a name no sibling takes, which
// is the shape the barrel census fails.
export { useActiveSessionStore, useSessionStoreRegistry } from "./session-lifecycle.js";
