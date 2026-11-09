//! The two keys that carry a session's `Auto memory` switch into a Codex conversation's `config`,
//! and the bare resume that carries them.

use serde_json::{Map, Value};

use super::compose_codex_bare_thread_resume_params;
use crate::driver::codex::app_server_protocol::ThreadResumeParams;

/// Codex's config path of whether a conversation is given the memories it holds.
const CODEX_USE_MEMORIES_KEY: &str = "memories.use_memories";

/// Codex's config path of whether a conversation feeds the memories Codex generates.
const CODEX_GENERATE_MEMORIES_KEY: &str = "memories.generate_memories";

/// The memory keys a conversation's `config` carries for the switch `auto_memory`: both false for
/// Off, both true for On, none where the switch was never set.
pub(super) fn compose_codex_memory_config(auto_memory: Option<bool>) -> Map<String, Value> {
    let mut config = Map::new();
    if let Some(switch) = auto_memory {
        config.insert(CODEX_USE_MEMORIES_KEY.to_owned(), Value::Bool(switch));
        config.insert(CODEX_GENERATE_MEMORIES_KEY.to_owned(), Value::Bool(switch));
    }
    config
}

/// The bare `thread/resume` params of `thread_id`, carrying the session's memory switch
/// `auto_memory`, so a conversation the service loads again starts under it.
pub(crate) fn compose_codex_bare_thread_resume_with_memory_switch(
    thread_id: String,
    auto_memory: Option<bool>,
) -> ThreadResumeParams {
    ThreadResumeParams {
        config: auto_memory.map(|switch| compose_codex_memory_config(Some(switch))),
        ..compose_codex_bare_thread_resume_params(thread_id)
    }
}

#[cfg(test)]
mod tests {
    use rstest::rstest;
    use serde_json::{Map, Value, json};

    use super::compose_codex_bare_thread_resume_with_memory_switch;
    use crate::driver::codex::session::test_fixture::test_thread_settings;
    use crate::driver::codex::thread::settings::{
        CodexThreadSettings, compose_codex_thread_fork_params, compose_codex_thread_resume_params,
        compose_codex_thread_start_params,
    };

    /// A request that loads a conversation and carries the session's memory switch.
    #[derive(Clone, Copy, Debug)]
    enum MemoryRequest {
        Start,
        Resume,
        Fork,
        BareResume,
    }

    // Killed by the keys left out of a start, resume or fork; by a switch never set sending them,
    // or defaulting to On; by `use_memories` sent alone; and by the bare resume carrying a
    // `config` with the switch unset.
    #[rstest]
    fn a_set_switch_rides_every_start_resume_and_fork(
        #[values(
            MemoryRequest::Start,
            MemoryRequest::Resume,
            MemoryRequest::Fork,
            MemoryRequest::BareResume
        )]
        request: MemoryRequest,
        #[values(None, Some(false), Some(true))] auto_memory: Option<bool>,
    ) {
        let settings = CodexThreadSettings {
            auto_memory,
            ..test_thread_settings()
        };
        let config = match request {
            MemoryRequest::Start => compose_codex_thread_start_params(&settings, Map::new()).config,
            MemoryRequest::Resume => {
                compose_codex_thread_resume_params(&settings, Map::new(), "thread".to_owned())
                    .config
            }
            MemoryRequest::Fork => {
                compose_codex_thread_fork_params(&settings, Map::new(), "thread".to_owned()).config
            }
            MemoryRequest::BareResume => {
                compose_codex_bare_thread_resume_with_memory_switch(
                    "thread".to_owned(),
                    auto_memory,
                )
                .config
            }
        };

        let is_bare_resume = matches!(request, MemoryRequest::BareResume);
        assert_eq!(
            config.is_some(),
            !is_bare_resume || auto_memory.is_some(),
            "a bare resume carries a config only for a set switch"
        );
        let memory_keys: Map<String, Value> = config
            .into_iter()
            .flatten()
            .filter(|(key, _)| key.starts_with("memories."))
            .collect();
        let expected = auto_memory.map_or_else(
            || json!({}),
            |switch| json!({"memories.use_memories": switch, "memories.generate_memories": switch}),
        );
        assert_eq!(Value::Object(memory_keys), expected);
    }
}
