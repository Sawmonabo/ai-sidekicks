// The notifications subtree's door.
//
// One surface — the notification center the sessions destination mounts — over one
// vocabulary, the attention plane. The stylesheet is imported here and nowhere
// else, so a surface can never render the center without it and the bundler sees
// one edge into the sheet.
//
// This subtree belongs to the collaboration family (T-023p-1C-4) and sits beside
// `sessions/` rather than inside it, because the plane is not a property of the
// all-sessions list: the same projection answers the list's per-row severity and
// the center's own grouping, and a vocabulary owned by one of its two consumers is
// a vocabulary the other reaches around.
//
// What is deliberately NOT here: any emission path. `attention.notificationEmit`
// is a control-plane mutation the daemon calls and never a client method, and
// `native.showNotification` is the shell's — the renderer cannot observe a click
// through a `void` return, so click routing is main-process-owned by construction.

import "./notifications.css";

export { NotificationCenter } from "./NotificationCenter.js";

// Only what crosses OUT of this subtree. The plane's vocabulary, its narrowing,
// and the fold are reached deeply from inside — an intra-subtree import is deep by
// the layout rule, and a barrel re-exporting a symbol nobody outside it imports is
// a door onto a room with no other entrance.
export {
  attentionProjectionReaderFor,
  useAttentionProjection,
  type AttentionReading,
} from "./attention-plane.js";
