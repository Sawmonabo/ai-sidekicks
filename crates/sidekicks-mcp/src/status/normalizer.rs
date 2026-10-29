//! The daemon's status producer of one session leg: each server name a driver reports is
//! attributed, through the attribution table, to the binding a session at the session's project
//! root serves it from, then applied to the leg's status; the leg's end retires that leg alone.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use sidekicks_contracts::place::PlacedPath;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::text::TextError;
use sidekicks_provider::driver::mcp_server::status::{
    McpServerStatusEmission, McpServerStatusProducer, McpServerStatusSink,
};
use sidekicks_workspace::project::records::AttachedProjectRoot;

use super::{McpLegStatusSink, McpServerStatusTracker};
use crate::binding::resolver::{McpAttributionTable, attached_root_path};

/// Where a session's reported server names are attributed: the attribution table, the provider
/// the session runs on and its project's root. Composed once per session and shared by the
/// producers of its legs.
#[derive(Clone)]
pub struct McpSessionAttribution {
    table: Arc<McpAttributionTable>,
    provider: ProviderId,
    root: PlacedPath,
}

impl McpSessionAttribution {
    /// The attribution of a session of `provider` in the project whose folder is `root`. Fails
    /// with the path's [`TextError`] when the stored root is no path the wire can carry.
    pub fn new(
        table: Arc<McpAttributionTable>,
        provider: ProviderId,
        root: &AttachedProjectRoot,
    ) -> Result<Self, TextError> {
        Ok(Self {
            table,
            provider,
            root: attached_root_path(root)?,
        })
    }
}

/// Opens the leg `binding_id` of `session_id` on `tracker` and answers its producer, which
/// attributes each name through `attribution`; the producer is bound to that leg, so the driver
/// it is handed to cannot report for another.
pub fn open_mcp_leg_status_producer(
    tracker: &Arc<McpServerStatusTracker>,
    attribution: McpSessionAttribution,
    session_id: SessionId,
    binding_id: RuntimeBindingId,
) -> McpServerStatusProducer {
    Arc::new(McpLegStatusProducer {
        sink: tracker.open_leg(session_id, binding_id),
        attribution,
        is_ended: AtomicBool::new(false),
    })
}

// One leg's producer: its sink on the tracker, where its names are attributed, and whether its
// leg has ended.
struct McpLegStatusProducer {
    sink: McpLegStatusSink,
    attribution: McpSessionAttribution,
    is_ended: AtomicBool,
}

impl McpLegStatusProducer {
    // Retires the leg the first time it is called, so an end and a later drop retire it once.
    fn retire_once(&self) {
        if !self.is_ended.swap(true, Ordering::SeqCst) {
            let leg = &self.sink.leg;
            self.sink
                .tracker
                .retire_leg(leg.session_id, leg.binding_id.clone());
        }
    }
}

impl McpServerStatusSink for McpLegStatusProducer {
    /// Applies the reading to the binding its name resolves to at the session's root; a name that
    /// resolves to none is logged and changes nothing.
    fn report_status(&self, emission: McpServerStatusEmission) {
        let McpSessionAttribution {
            table,
            provider,
            root,
        } = &self.attribution;
        let Some(binding) = table.resolve(provider, root, emission.server_name()) else {
            tracing::debug!(
                session_id = %self.sink.leg.session_id,
                binding_id = self.sink.leg.binding_id.as_str(),
                server_name = emission.server_name().as_str(),
                "an MCP server a session reported resolves to no binding at its root"
            );
            return;
        };
        self.sink.observe(&binding, emission);
    }

    /// Retires the producer's own leg, once however often it is called.
    fn end_leg(&self) {
        self.retire_once();
    }
}

// A producer let go before its process ended, as when the start it was composed for failed, retires
// its leg, so the tracker forgets the leg once its sink closes.
impl Drop for McpLegStatusProducer {
    fn drop(&mut self) {
        self.retire_once();
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use futures::FutureExt as _;
    use sidekicks_contracts::free_form_string::FilesystemPath;
    use sidekicks_contracts::mcp::server::McpServerStatus::{self, Connected, Failed};
    use sidekicks_contracts::mcp::server::{McpServerBindingRef, McpServerName};
    use sidekicks_contracts::place::PlacedPath;
    use sidekicks_contracts::project::ProjectId;
    use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
    use sidekicks_contracts::provider::id::ProviderId;
    use sidekicks_contracts::repo::mount::RepoMountId;
    use sidekicks_contracts::session::id::SessionId;
    use sidekicks_contracts::wire::id::mint_uuid_v7;
    use sidekicks_ipc::stream::feed::{CreditGate, Feed};
    use sidekicks_provider::driver::mcp_server::read::McpRootReading;
    use sidekicks_provider::driver::mcp_server::status::{
        McpServerReading, McpServerStatusEmission,
    };
    use sidekicks_workspace::project::records::AttachedProjectRoot;

    use super::{McpSessionAttribution, open_mcp_leg_status_producer};
    use crate::binding::resolver::McpAttributionTable;
    use crate::binding::store::McpBindingKey;
    use crate::status::open_test_tracker;

    const ROOT: &str = "/work/docs";

    fn provider() -> ProviderId {
        ProviderId::new("provider-a".to_owned()).expect("a provider id")
    }

    fn server_name(name: &str) -> McpServerName {
        McpServerName::new(name.to_owned()).expect("a server name")
    }

    fn binding(name: &str) -> McpServerBindingRef {
        McpServerBindingRef::Project {
            provider: provider(),
            scope_ref: FilesystemPath::new(ROOT.to_owned()).expect("a path"),
            place: None,
            server_name: server_name(name),
        }
    }

    // A session at `ROOT`, whose provider loads `docs` there.
    fn attribution() -> McpSessionAttribution {
        let table = Arc::new(McpAttributionTable::default());
        let root = PlacedPath {
            path: FilesystemPath::new(ROOT.to_owned()).expect("a path"),
            place: None,
        };
        table.replace_provider_loaded(
            &provider(),
            &[McpRootReading {
                root,
                kept_out_server_names: Vec::new(),
                provider_loaded: vec![binding("docs")],
            }],
        );
        McpSessionAttribution::new(
            table,
            provider(),
            &AttachedProjectRoot {
                project_id: ProjectId::new(&mint_uuid_v7().to_string()).expect("a project id"),
                repo_mount_id: RepoMountId::new("mount").expect("a mount id"),
                canonical_root: ROOT.into(),
                place: None,
            },
        )
        .expect("the root is a path")
    }

    fn report(name: &str, status: McpServerStatus) -> McpServerStatusEmission {
        McpServerStatusEmission::new(server_name(name), McpServerReading::Observed(status), None)
    }

    // Two legs of one session report `docs`; one producer's end leaves the other leg reading it.
    // Killed by the end ignored (both legs stay) and by the end retiring the whole session (no
    // leg stays); a second end changing nothing is held by the one leg left.
    #[tokio::test]
    async fn a_producers_end_retires_exactly_its_own_leg() {
        let (tracker, _subscriber, _first_observations) = open_test_tracker().await;
        let session_id = SessionId::try_from(mint_uuid_v7()).expect("a session id");
        let [ended_leg, kept_leg] = ["leg-ended", "leg-kept"]
            .map(|name| RuntimeBindingId::new(name.to_owned()).expect("a binding id"));
        let ended =
            open_mcp_leg_status_producer(&tracker, attribution(), session_id, ended_leg.clone());
        let kept =
            open_mcp_leg_status_producer(&tracker, attribution(), session_id, kept_leg.clone());
        ended.report_status(report("docs", Failed));
        kept.report_status(report("docs", Connected));

        ended.end_leg();
        ended.end_leg();

        let reading = tracker.reading(&McpBindingKey::of(&binding("docs")));
        let legs: Vec<_> = reading.legs.iter().map(|leg| &leg.binding_id).collect();
        assert_eq!(legs, [&kept_leg]);
        assert_eq!(reading.status, Connected);
        drop(kept);
    }

    // A name the table holds no binding for at the session's root adds no leg to any binding and
    // hands no binding on to be recorded. Killed by a row made for the unknown name.
    #[tokio::test]
    async fn a_name_with_no_binding_adds_no_leg_and_no_row() {
        let (tracker, _subscriber, mut first_observations) = open_test_tracker().await;
        let session_id = SessionId::try_from(mint_uuid_v7()).expect("a session id");
        let producer = open_mcp_leg_status_producer(
            &tracker,
            attribution(),
            session_id,
            RuntimeBindingId::new("leg-a".to_owned()).expect("a binding id"),
        );

        producer.report_status(report("mail", Connected));

        assert!(
            tracker
                .reading(&McpBindingKey::of(&binding("mail")))
                .legs
                .is_empty()
        );
        let gate = CreditGate::with_credit(1);
        assert!(
            first_observations.next(&gate).now_or_never().is_none(),
            "no binding is handed on to be recorded"
        );
    }
}
