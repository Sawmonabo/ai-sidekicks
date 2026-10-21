//! The transcript: reply bodies, run facts, turn attribution, file patches and the windows a
//! client reads.

pub(crate) mod body;
pub(crate) mod child_run;
pub(crate) mod patch_list;
pub(crate) mod projector;
pub(crate) mod reasoning;
pub(crate) mod rejoin;
pub(crate) mod run_facts;
pub(crate) mod stream_state;
#[cfg(test)]
pub(crate) mod test_log;
pub(crate) mod turn_attribution;
pub(crate) mod whole_patch;
pub(crate) mod window;
