// The one fixture the run-lifecycle projector's two suites share.
//
// Both suites drive a payload no scenario scripts, and each needs the same session
// to deliver it on. The constant was written twice — once in each file, with the
// same bytes — and the fold under test REFUSES a beat whose payload names another
// session, so two suites that had drifted apart on the value would each still pass
// while testing opposite halves of that one guard. Declared here instead, on
// `apps/desktop/AGENTS.md` §Shared code: a helper used by two modules lives once.
//
// ONLY THE CONSTANT LIVES HERE. Each suite keeps its own beat builder, because the
// two are deliberately different — one takes the payload WHOLE, since half its cases
// are about a member the beat does NOT carry, and the other writes the envelope's
// session in, since every case that reaches for it is about the BODY and would be
// refused by the session guard before a body was ever read. A builder with one
// reader is not shared code, and moving it here would say it was.

/** The session every synthetic beat and event in this directory's suites is delivered on. */
export const SYNTHETIC_SESSION_ID = "019b79ee-0280-75e5-8510-ada11a5a11a5";
