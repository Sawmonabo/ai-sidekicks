// The one fixture the run-lifecycle projector's two suites share: the session id their synthetic
// beats are delivered on. The fold refuses a payload naming another session, so two copies that
// drifted would test opposite halves of that guard. Each suite keeps its own beat builder,
// because they differ deliberately.

/** The session every synthetic beat and event in this directory's suites is delivered on. */
export const SYNTHETIC_SESSION_ID = "019b79ee-0280-75e5-8510-ada11a5a11a5";
