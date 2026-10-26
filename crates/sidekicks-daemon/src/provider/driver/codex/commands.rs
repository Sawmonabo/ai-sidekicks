//! The Codex driver's provider commands: the reader that turns a `skills/list` reply into command
//! entries and the file each skill loads from, the per-session listing, read once per session and
//! discarded on `skills/changed` and with the session, the tool servers' prompts beside it, and
//! the listeners that follow a session's list as it changes.

#[cfg(test)]
mod tests;

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{Map, Value};
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::driver::commands::{
    ProviderCommandBinding, ProviderCommandBindingGroup, ProviderCommandEntry,
    ProviderCommandListResponse,
};
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::list::BoundedVec;
use sidekicks_contracts::wire::text::{FreeFormText, NonEmptyText};

use crate::mutex_lock::lock;
use crate::provider::driver::codex::DESCRIPTOR;
use crate::provider::driver::codex::app_server_protocol::SkillsListParams;
use crate::provider::driver::codex::service::supervisor::CodexService;
use crate::provider::driver::codex::session::errors::CodexError;
use crate::provider::driver::codex::transport::diagnostics::CodexTransportDiagnostic;
use crate::provider::driver::contract::ProviderCommandsSubscription;
use crate::provider::driver::diagnostics::{
    DriverDiagnosticKind, DriverDiagnosticRecord, OnceReportedDiagnostics,
};
use crate::provider::driver::run_control::PickedSkill;
use crate::provider::driver::session_control::ProviderCommandsListener;
use crate::provider::port::registration::PortRegistration;
use crate::provider::port::server_prompts::ServerPromptPort;

/// The provider's live skill listing.
const CODEX_SKILLS_LIST_METHOD: &str = "skills/list";

/// What one live session's list is read from: its service, the account it runs on, its own folder
/// and the run whose list it is.
#[derive(Clone)]
pub(crate) struct CodexCommandSource {
    /// The session.
    pub(crate) session_id: SessionId,
    /// The service its conversation is loaded on.
    pub(crate) service: Arc<CodexService>,
    /// The account, `None` on the machine's default home.
    pub(crate) provider_account_id: Option<ProviderAccountId>,
    /// The session's own folder: one service holds every session of the account, so the default
    /// folder would be the service's.
    pub(crate) working_directory: String,
    /// The session's one live run, where one runs.
    pub(crate) run_id: Option<RunId>,
}

/// Finds a live session's source, `None` once it closed.
pub(crate) type CodexCommandSourceLookup =
    Arc<dyn Fn(SessionId) -> Option<CodexCommandSource> + Send + Sync>;

/// One `skills/list` reply's entries and the file each listed skill loads from.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct CodexSkillListing {
    /// The entries, in the reply's order.
    pub(crate) entries: Vec<ProviderCommandEntry>,
    /// Each skill with a file, by its name.
    pub(crate) skill_files: Vec<PickedSkill>,
}

/// Holds each session's listing and composes the reply from it, for every session of one driver.
pub(crate) struct CodexProviderCommandCache {
    server_prompts: Arc<PortRegistration<Arc<dyn ServerPromptPort>>>,
    source_for: CodexCommandSourceLookup,
    /// The generation a held listing must be read under, counted for the whole cache and never
    /// reset, so a reused session id never matches an earlier read's.
    next_generation: AtomicU64,
    state: Mutex<CacheState>,
    /// The entry faults already logged, each logged once per kind.
    rejections: Mutex<OnceReportedDiagnostics>,
}

#[derive(Default)]
struct CacheState {
    listings: HashMap<SessionId, CodexSkillListing>,
    /// Each session's current generation; a read stores its listing only while it stands.
    generation_by_session: HashMap<SessionId, u64>,
    /// Each session's listeners, by their own id, each with the call that stops its watch of the
    /// tool servers' prompts.
    listeners: HashMap<SessionId, Vec<CommandListener>>,
    next_listener_id: u64,
}

struct CommandListener {
    id: u64,
    listener: ProviderCommandsListener,
    stop_watching: Option<Box<dyn FnOnce() + Send>>,
}

impl CodexProviderCommandCache {
    /// A cache reading the tool servers' prompts through `server_prompts` and each live session's
    /// source through `source_for`.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the daemon's start registers the driver, which builds the one command cache \
                      its sessions share"
        )
    )]
    pub(crate) fn new(
        server_prompts: Arc<PortRegistration<Arc<dyn ServerPromptPort>>>,
        source_for: CodexCommandSourceLookup,
    ) -> Arc<Self> {
        Arc::new(Self {
            server_prompts,
            source_for,
            next_generation: AtomicU64::new(1),
            state: Mutex::new(CacheState::default()),
            rejections: Mutex::new(OnceReportedDiagnostics::default()),
        })
    }

    /// The whole command list of one session, from the held listing or a fresh read.
    pub(crate) async fn compose_provider_command_list(
        &self,
        source: &CodexCommandSource,
    ) -> Result<ProviderCommandListResponse, CodexError> {
        let binding = ProviderCommandBinding {
            provider_name: DESCRIPTOR.provider_id(),
            provider_account_id: source.provider_account_id.clone(),
        };
        let mut entries = self.held_listing_for(source).await?.entries;
        if let Some(port) = self.server_prompts.port() {
            entries.extend(port.read_prompts(source.session_id, binding.clone()).await);
        }
        let group = ProviderCommandBindingGroup {
            run_id: source.run_id,
            binding,
            entries,
        };
        Ok(ProviderCommandListResponse {
            bindings: BoundedVec::new(vec![group]).expect("one group is within the bounds"),
        })
    }

    /// Each skill Codex lists for the session, by its name and the file it loads it from: the
    /// live session's held listing, else a read from `service` over `working_directory`.
    pub(crate) async fn read_skill_files(
        &self,
        session_id: SessionId,
        service: &CodexService,
        working_directory: &Path,
    ) -> Result<Vec<PickedSkill>, CodexError> {
        if let Some(source) = (self.source_for)(session_id) {
            return Ok(self.held_listing_for(&source).await?.skill_files);
        }
        let reply =
            request_skills(service, working_directory.to_string_lossy().into_owned()).await?;
        Ok(self.read_reply(session_id, &reply, None)?.skill_files)
    }

    /// Follows a session's live list: `listener` gets the current list now and each new one after
    /// Codex's skills or a tool server's prompts change, until the subscription drops.
    #[expect(
        dead_code,
        reason = "the `session.providerCommand.subscribe` handler follows a session's list \
                  through the driver"
    )]
    pub(crate) fn subscribe(
        self: &Arc<Self>,
        session_id: SessionId,
        listener: ProviderCommandsListener,
    ) -> ProviderCommandsSubscription {
        let id = {
            let mut state = lock(&self.state);
            state.next_listener_id += 1;
            state.next_listener_id
        };
        let stop_watching = self.server_prompts.port().map(|port| {
            let cache = Arc::downgrade(self);
            let watched = Arc::clone(&listener);
            port.watch_prompts(
                session_id,
                Arc::new(move || {
                    if let Some(cache) = cache.upgrade() {
                        cache.send_list(session_id, Arc::clone(&watched));
                    }
                }),
            )
        });
        lock(&self.state)
            .listeners
            .entry(session_id)
            .or_default()
            .push(CommandListener {
                id,
                listener: Arc::clone(&listener),
                stop_watching,
            });
        self.send_list(session_id, listener);
        let cache = Arc::downgrade(self);
        ProviderCommandsSubscription::new(move || {
            let Some(cache) = cache.upgrade() else {
                return;
            };
            let removed = {
                let mut state = lock(&cache.state);
                let listeners = state.listeners.entry(session_id).or_default();
                let removed = listeners
                    .iter()
                    .position(|kept| kept.id == id)
                    .map(|at| listeners.remove(at));
                if listeners.is_empty() {
                    state.listeners.remove(&session_id);
                }
                removed
            };
            if let Some(stop_watching) = removed.and_then(|removed| removed.stop_watching) {
                stop_watching();
            }
        })
    }

    /// Discards a session's held listing after Codex's skills changed, then reads it again for
    /// its listeners.
    pub(crate) fn refresh(self: &Arc<Self>, session_id: SessionId) {
        self.discard_listing(session_id);
        let listeners: Vec<ProviderCommandsListener> = lock(&self.state)
            .listeners
            .get(&session_id)
            .map(|listeners| {
                listeners
                    .iter()
                    .map(|kept| Arc::clone(&kept.listener))
                    .collect()
            })
            .unwrap_or_default();
        for listener in listeners {
            self.send_list(session_id, listener);
        }
    }

    /// Forgets a closed session: its listing, its generation, its listeners and their watches.
    pub(crate) fn forget_session(&self, session_id: SessionId) {
        let listeners = {
            let mut state = lock(&self.state);
            state.listings.remove(&session_id);
            state.generation_by_session.remove(&session_id);
            state.listeners.remove(&session_id).unwrap_or_default()
        };
        for stop_watching in listeners.into_iter().filter_map(|kept| kept.stop_watching) {
            stop_watching();
        }
    }

    /// Clears a session's listing and generation together; a read in flight then stores nothing.
    pub(crate) fn discard_listing(&self, session_id: SessionId) {
        let mut state = lock(&self.state);
        state.listings.remove(&session_id);
        state.generation_by_session.remove(&session_id);
    }

    // The held listing, read from the provider if absent. The generation taken before the request
    // is checked again before storing, so a discard mid-flight leaves the reading unheld.
    async fn held_listing_for(
        &self,
        source: &CodexCommandSource,
    ) -> Result<CodexSkillListing, CodexError> {
        let generation = {
            let mut state = lock(&self.state);
            if let Some(held) = state.listings.get(&source.session_id) {
                return Ok(held.clone());
            }
            *state
                .generation_by_session
                .entry(source.session_id)
                .or_insert_with(|| self.next_generation.fetch_add(1, Ordering::Relaxed))
        };
        let reply = request_skills(&source.service, source.working_directory.clone()).await?;
        let listing = self.read_reply(
            source.session_id,
            &reply,
            source.provider_account_id.clone(),
        )?;
        let mut state = lock(&self.state);
        if state.generation_by_session.get(&source.session_id) == Some(&generation) {
            state.listings.insert(source.session_id, listing.clone());
        }
        Ok(listing)
    }

    fn read_reply(
        &self,
        session_id: SessionId,
        reply: &Value,
        provider_account_id: Option<ProviderAccountId>,
    ) -> Result<CodexSkillListing, CodexError> {
        let reading = read_codex_skill_listing(reply, provider_account_id)?;
        let mut reported = lock(&self.rejections);
        for rejection in reading.rejections {
            reported.report(&rejection.record(session_id));
        }
        Ok(reading.listing)
    }

    // Reads the session's list and hands it to `listener`; a failed read is reported.
    fn send_list(self: &Arc<Self>, session_id: SessionId, listener: ProviderCommandsListener) {
        let Some(source) = (self.source_for)(session_id) else {
            return;
        };
        let cache = Arc::clone(self);
        tokio::spawn(async move {
            match cache.compose_provider_command_list(&source).await {
                Ok(list) => listener(list),
                Err(error) => CodexTransportDiagnostic::ProviderCommandListFailed {
                    session_id,
                    error: Box::new(error),
                }
                .report(),
            }
        });
    }
}

// Asks the service for the skills of `working_directory`, with no forced re-scan: freshness comes
// from `skills/changed`.
async fn request_skills(
    service: &CodexService,
    working_directory: String,
) -> Result<Value, CodexError> {
    let params = SkillsListParams {
        cwds: vec![working_directory],
        force_reload: None,
    };
    let reply = service
        .connection()?
        .request(CODEX_SKILLS_LIST_METHOD, &params)
        .await?;
    serde_json::from_str(reply.get()).map_err(|error| CodexError::Transport {
        detail: format!("The Codex service's \"{CODEX_SKILLS_LIST_METHOD}\" reply is no JSON."),
        cause: Some(Box::new(error)),
    })
}

/// A field of one listed skill the contract's bounds refused, or a skill that is no object.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CodexSkillRejection {
    /// A skill that is no object, which names nothing; dropped.
    NotAnObject,
    /// A name the bounds refuse; the skill is dropped.
    Name {
        /// The name's length, `None` where it was no text.
        name_length: Option<usize>,
    },
    /// A description the bounds refuse; the skill is kept without one.
    Description {
        /// The name's length.
        name_length: Option<usize>,
        /// The refused value's length, `None` where it was no text.
        value_length: Option<usize>,
    },
    /// A scope the bounds refuse; the skill is kept without one.
    Scope {
        /// The name's length.
        name_length: Option<usize>,
        /// The refused value's length, `None` where it was no text.
        value_length: Option<usize>,
    },
}

impl CodexSkillRejection {
    // The refused field's name, which the record and its once-per-kind key carry.
    fn field(self) -> &'static str {
        match self {
            Self::NotAnObject => "entry",
            Self::Name { .. } => "name",
            Self::Description { .. } => "description",
            Self::Scope { .. } => "scope",
        }
    }

    // The diagnostic record: lengths only, never the refused value.
    fn record(self, session_id: SessionId) -> DriverDiagnosticRecord {
        let (is_dropped, name_length, value_length) = match self {
            Self::NotAnObject => (true, None, None),
            Self::Name { name_length } => (true, name_length, None),
            Self::Description {
                name_length,
                value_length,
            }
            | Self::Scope {
                name_length,
                value_length,
            } => (false, name_length, value_length),
        };
        let disposition_reason = if is_dropped {
            "the provider published a skill entry the contract's own bounds refuse; it is dropped \
             from this reply and its siblings are unaffected"
        } else {
            "the provider declared a skill field the contract's own bounds refuse; the entry is \
             kept and the field reads absent, which on this contract means the provider declared \
             none"
        };
        DriverDiagnosticRecord {
            provider: DESCRIPTOR.provider_id(),
            provider_account_id: None,
            kind: DriverDiagnosticKind::ProviderCommandEntryRejected,
            raw_wire_type: Some(format!("{CODEX_SKILLS_LIST_METHOD}:{}", self.field())),
            disposition_reason: disposition_reason.to_owned(),
            details: Map::from_iter([
                ("sessionId".to_owned(), Value::from(session_id.to_string())),
                ("entryKind".to_owned(), Value::from("skill")),
                ("rejectedField".to_owned(), Value::from(self.field())),
                ("dropped".to_owned(), Value::from(is_dropped)),
                (
                    "nameLength".to_owned(),
                    name_length.map_or(Value::Null, Value::from),
                ),
                (
                    "rejectedValueLength".to_owned(),
                    value_length.map_or(Value::Null, Value::from),
                ),
            ]),
        }
    }
}

/// One `skills/list` reply's listing and every field reading it refused.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct CodexSkillListReading {
    /// The listing.
    pub(crate) listing: CodexSkillListing,
    /// The refusals, in the reply's order.
    pub(crate) rejections: Vec<CodexSkillRejection>,
}

/// Reads a `skills/list` reply, its per-folder groups joined, into its entries and each skill's
/// file. Fails for a reply with no `data` list: reading it as no skills would claim the provider
/// has none.
pub(crate) fn read_codex_skill_listing(
    reply: &Value,
    provider_account_id: Option<ProviderAccountId>,
) -> Result<CodexSkillListReading, CodexError> {
    let Some(groups) = reply.get("data").and_then(Value::as_array) else {
        return Err(CodexError::Transport {
            detail: format!(
                "The Codex app-server's \"{CODEX_SKILLS_LIST_METHOD}\" reply carries no skill list."
            ),
            cause: None,
        });
    };
    let binding = ProviderCommandBinding {
        provider_name: DESCRIPTOR.provider_id(),
        provider_account_id,
    };
    let mut reading = CodexSkillListReading {
        listing: CodexSkillListing::default(),
        rejections: Vec::new(),
    };
    let skills = groups
        .iter()
        .filter_map(|group| group.get("skills")?.as_array())
        .flatten();
    for skill in skills {
        let Some(skill) = skill.as_object() else {
            reading.rejections.push(CodexSkillRejection::NotAnObject);
            continue;
        };
        let Some(entry) = read_skill_entry(skill, &binding, &mut reading.rejections) else {
            continue;
        };
        // A row with no readable file cannot be picked: no path but Codex's own reaches it.
        let path = skill
            .get("path")
            .and_then(Value::as_str)
            .and_then(|path| NonEmptyText::new(path.to_owned()));
        if let (Some(path), ProviderCommandEntry::Skill { name, .. }) = (path, &entry) {
            reading.listing.skill_files.push(PickedSkill {
                name: NonEmptyText::new(name.as_str().to_owned()).expect("a checked name is text"),
                path,
            });
        }
        reading.listing.entries.push(entry);
    }
    Ok(reading)
}

// One listed skill as its entry, each field the bounds refuse recorded; only a refused name drops
// it. `enabled` is the provider's own value, absent where it published none.
fn read_skill_entry(
    skill: &Map<String, Value>,
    binding: &ProviderCommandBinding,
    rejections: &mut Vec<CodexSkillRejection>,
) -> Option<ProviderCommandEntry> {
    let raw_name = skill.get("name").and_then(Value::as_str);
    let name_length = raw_name.map(|name| name.chars().count());
    let Some(name) = raw_name.and_then(|name| FreeFormText::new(name.to_owned()).ok()) else {
        rejections.push(CodexSkillRejection::Name { name_length });
        return None;
    };
    let description = match read_field(skill.get("description"), true) {
        FieldReading::Read(text) => Some(text),
        FieldReading::Undeclared => None,
        FieldReading::Rejected(value_length) => {
            rejections.push(CodexSkillRejection::Description {
                name_length,
                value_length,
            });
            None
        }
    };
    let scope = match read_field(skill.get("scope"), false) {
        FieldReading::Read(text) => Some(text),
        FieldReading::Undeclared => None,
        FieldReading::Rejected(value_length) => {
            rejections.push(CodexSkillRejection::Scope {
                name_length,
                value_length,
            });
            None
        }
    };
    Some(ProviderCommandEntry::Skill {
        name,
        description,
        argument_hint: None,
        scope,
        enabled: skill.get("enabled").and_then(Value::as_bool),
        binding: binding.clone(),
        server: None,
    })
}

// One optional field: read, undeclared, or refused by its bound with the refused value's length.
enum FieldReading<const MAX: usize> {
    Read(FreeFormText<MAX>),
    Undeclared,
    Rejected(Option<usize>),
}

// Reads an optional field against its bound; `is_blank_undeclared` is per field, since only some
// members can say "none" with blank text.
fn read_field<const MAX: usize>(
    raw: Option<&Value>,
    is_blank_undeclared: bool,
) -> FieldReading<MAX> {
    match raw {
        None | Some(Value::Null) => FieldReading::Undeclared,
        Some(Value::String(text)) if is_blank_undeclared && text.trim().is_empty() => {
            FieldReading::Undeclared
        }
        Some(Value::String(text)) => match FreeFormText::new(text.clone()) {
            Ok(text) => FieldReading::Read(text),
            Err(_) => FieldReading::Rejected(Some(text.chars().count())),
        },
        Some(_) => FieldReading::Rejected(None),
    }
}
