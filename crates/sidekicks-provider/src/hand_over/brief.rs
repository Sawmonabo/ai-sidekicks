//! The hand-over brief: the bounded prose that stands in for a conversation a new provider session
//! cannot continue, its one send into each target, and the fixed template its summary answers.

pub(crate) mod delivery;
pub(crate) mod projection;

/// The fixed template a throwaway copy answers for the brief's summary where the provider's own
/// summary cannot be read, and where the provider takes the template as its summary.
pub(crate) const HANDOVER_SUMMARY_TEMPLATE: &str = "Write a hand-over summary of this whole \
conversation for a different assistant that will pick the work up. Answer these nine parts, each \
as its own short numbered block, and nothing else:
1. The goal of this work.
2. What has been done so far.
3. Which files were changed and how.
4. The current state of the tests.
5. Decisions the person made that still hold and are not implemented yet. State each decision \
once, as \"<what it applies to>: <its current value>\" (for example \"retry limit: 3\"). Then, \
under its own heading \"Withdrawn, do not use\", list every value the person withdrew or \
replaced, each with what it applied to.
6. What is left to do.
7. Anything that must not be changed. Withdrawn decisions never go here; they go under \
\"Withdrawn, do not use\".
8. Open questions.
9. How to verify the work.";
