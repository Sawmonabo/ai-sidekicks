//! The transcript: reply bodies, run facts, turn attribution, file patches and the windows a
//! client reads.

pub mod block_cut;
pub(crate) mod body;
pub(crate) mod child_run;
pub(crate) mod escape_sequences;
pub(crate) mod patch_list;
pub(crate) mod projector;
pub(crate) mod reasoning;
pub(crate) mod run_facts;
pub mod stream_state;
#[cfg(any(test, feature = "test-support"))]
pub mod test_log;
pub mod turn_attribution;
pub mod window;
