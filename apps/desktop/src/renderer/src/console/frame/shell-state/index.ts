// The honest-chrome plane's door.
//
// A sub-module door inside `frame/`; it publishes the one action that leaves it.
//
// THE STATE IS NOT HERE. It lives on the frame store, because the settings pages read
// it too and they sit on the other side of this family in the console DAG — a view
// family may not import a sub-module door at all, and the frame's own door would close
// a cycle. The vocabulary and the sentences both sides say therefore live in
// `store/shell/shell-state.ts`, which is the lowest family that owns the inputs.

export { useDaemonStartAction } from "./shell-status-binding.js";
