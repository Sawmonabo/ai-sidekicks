// The send router's door.
//
// One of the composer's zones. The router resolves Send to the one wire call
// the addressed target admits, so the input, the action, and that resolution are
// one lane's work and live behind one barrel.
//
// The zone forwards its BODY and nothing else. The router class, the refusal
// vocabulary, the directive-line model, the controller hook, and the
// command-executor contract are all reached deeply from inside this family, which
// is what this package's structure rules ask for — a barrel is the CROSS-FAMILY
// door, and a re-export of a symbol only this family reads would advertise a seam
// that does not exist.
//
// `command-executor.ts` is the one to say that about, because it looks like a door
// and is not: the controller awaits an outcome and the composer's command zone
// produces one, and both live in this family, so both name that module directly.

export { ComposerSendBar } from "./ComposerSendBar.js";
