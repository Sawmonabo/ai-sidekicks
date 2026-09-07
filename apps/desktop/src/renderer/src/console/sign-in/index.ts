// The sign-in family's door.
//
// ONE SYMBOL, the overlay, because that is all that crosses this family's boundary:
// `App.tsx` composes window-scoped overlays and nothing else names a ceremony, a
// state, or the adapter. The stylesheet enters here because this directory owns it.
//
// The ceremony adapter is deliberately unpublished. It is the one module that names
// the `webAuthn` bridge namespace, and a door line for it would invite a second
// caller — which is exactly what would make the NS-99 narrowing a sweep instead of a
// one-file change.

import "./sign-in.css";

export { SignInOverlay } from "./SignInOverlay.js";
