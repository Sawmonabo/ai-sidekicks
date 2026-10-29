//! The binding resolver: each provider's reading folded into binding rows beside what the store
//! keeps for them, the attached project roots as a driver's read takes them, and the attribution
//! table that says which binding a server name a session reports resolves to.

use std::collections::HashMap;
use std::fmt;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, Weak};

use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::mcp::server::config::McpServerConfigView;
use sidekicks_contracts::mcp::server::{McpBindingScope, McpServerBindingRef, McpServerName};
use sidekicks_contracts::place::{Place, PlacedPath};
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::wire::text::TextError;
use sidekicks_provider::driver::mcp_server::read::{
    McpServerDeclaration, ProviderMcpServersReading,
};
use sidekicks_std::mutex_lock::lock;
use sidekicks_workspace::project::records::AttachedProjectRoot;

use crate::binding::store::{McpBindingKey, McpStoredBinding, McpStoredBindings};

/// One binding as the inventory lists it: the driver's declaration, under the binding it is
/// served as, and what the store keeps for it.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct McpBindingRow {
    /// The declaration; an emulated `local` binding carries the user entry's declaration under
    /// its `local` binding.
    pub(crate) declaration: McpServerDeclaration,
    /// What the store keeps for the binding, the default where it has no row yet; `None` when the
    /// store did not answer.
    pub(crate) stored: Option<McpStoredBinding>,
}

/// Folds one provider's reading into its binding rows, the account servers' among them, one row
/// per binding and none merged across scopes. A `local` row of the store that the reading does not
/// declare, matching a user entry of the same name that is off by default, is the emulated
/// `local` binding: that user entry lists as `local` under the row's root and not as `user`. A
/// `local` row matching no declaration lists nothing. With no `stored`, nothing is emulated.
pub(crate) fn resolve_binding_rows(
    reading: &ProviderMcpServersReading,
    stored: Option<&McpStoredBindings>,
) -> Vec<McpBindingRow> {
    let declarations: Vec<&McpServerDeclaration> = reading
        .declarations
        .iter()
        .chain(
            reading
                .account_servers
                .iter()
                .flat_map(|account| &account.declarations),
        )
        .collect();
    let emulated_locals: Vec<&McpServerBindingRef> = stored
        .map(|stored| {
            stored
                .local_bindings
                .iter()
                .filter(|local| {
                    !declarations
                        .iter()
                        .any(|declaration| &declaration.binding == *local)
                })
                .collect()
        })
        .unwrap_or_default();
    let stored_binding = |binding: &McpServerBindingRef| {
        stored.map(|stored| {
            stored
                .bindings
                .get(&McpBindingKey::of(binding))
                .cloned()
                .unwrap_or_default()
        })
    };
    let mut rows = Vec::with_capacity(declarations.len());
    for declaration in declarations {
        let McpServerBindingRef::User {
            provider,
            server_name,
        } = &declaration.binding
        else {
            rows.push(McpBindingRow {
                declaration: declaration.clone(),
                stored: stored_binding(&declaration.binding),
            });
            continue;
        };
        let locals: Vec<&McpServerBindingRef> = if is_off_by_default(&declaration.config) {
            emulated_locals
                .iter()
                .copied()
                .filter(|local| is_local_of(local, provider, server_name))
                .collect()
        } else {
            Vec::new()
        };
        if locals.is_empty() {
            rows.push(McpBindingRow {
                declaration: declaration.clone(),
                stored: stored_binding(&declaration.binding),
            });
        }
        for local in locals {
            rows.push(McpBindingRow {
                declaration: McpServerDeclaration {
                    binding: local.clone(),
                    ..declaration.clone()
                },
                stored: stored_binding(local),
            });
        }
    }
    rows
}

// Whether a declaration's own `enabled` is off, as the user entry of an emulated `local` binding is
// written.
fn is_off_by_default(config: &McpServerConfigView) -> bool {
    let enabled = match config {
        McpServerConfigView::Stdio { enabled, .. }
        | McpServerConfigView::Http { enabled, .. }
        | McpServerConfigView::Sse { enabled, .. } => enabled,
    };
    *enabled == Some(false)
}

fn is_local_of(
    binding: &McpServerBindingRef,
    provider: &ProviderId,
    server_name: &McpServerName,
) -> bool {
    matches!(
        binding,
        McpServerBindingRef::Local { provider: local_provider, server_name: local_name, .. }
            if local_provider == provider && local_name == server_name
    )
}

/// An attached project's root as a driver's read takes it: its path, and the WSL 2 distribution
/// it is in, none on Windows itself or outside Windows. Fails with the path's [`TextError`] when
/// the stored root is empty, holds a NUL or passes the path cap.
pub(crate) fn attached_root_path(root: &AttachedProjectRoot) -> Result<PlacedPath, TextError> {
    Ok(PlacedPath {
        path: FilesystemPath::new(root.canonical_root.to_string_lossy().into_owned())?,
        place: match &root.place {
            Some(Place::Wsl(place)) => Some(place.clone()),
            Some(Place::Windows(_)) | None => None,
        },
    })
}

/// The scopes a session in no project root loads its servers from, in the order a name two of them
/// declare resolves: an administrator's first, as both providers rank it above the person's.
const ROOT_FREE_SCOPES: [McpBindingScope; 4] = [
    McpBindingScope::Managed,
    McpBindingScope::User,
    McpBindingScope::Plugin,
    McpBindingScope::Connector,
];

/// Which binding each server name a session reports resolves to, per provider and project root:
/// the set the daemon sent there, then what the provider loads there by its own config; and for
/// a session in no root, the provider's root-free bindings. It sits behind a lock taken only for
/// a lookup or a replacement, never across an await, so a status producer reads it without
/// waiting. Each read that replaces it is stamped before its driver read, so an older read that
/// finishes later replaces nothing; a leg holding a report no name resolved waits on it and is
/// handed each replacement.
#[derive(Debug, Default)]
pub struct McpAttributionTable {
    roots: Mutex<McpAttributionRoots>,
    next_read_stamp: AtomicU64,
    waiting_legs: McpWaitingLegs,
}

/// A leg holding reports whose names resolved to no binding, handed each replacement of the table
/// to resolve them again.
pub(crate) trait McpUnresolvedReports: Send + Sync {
    /// Resolves the held reports against the table again, applying each that resolves now.
    fn resolve_again(&self);
}

// The legs waiting on the table's next replacement, each held weakly so a retired leg goes.
#[derive(Default)]
struct McpWaitingLegs(Mutex<Vec<Weak<dyn McpUnresolvedReports>>>);

impl fmt::Debug for McpWaitingLegs {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("McpWaitingLegs")
            .field("count", &lock(&self.0).len())
            .finish()
    }
}

/// The table's bindings, per provider, root and server name.
#[derive(Debug, Default)]
struct McpAttributionRoots {
    /// The set the daemon sent each root's sessions; nothing sends one yet.
    sent: HashMap<ProviderId, HashMap<PlacedPath, HashMap<McpServerName, McpServerBindingRef>>>,
    /// What the provider loads at each root by its own config, as its last inventory read said.
    provider_loaded:
        HashMap<ProviderId, HashMap<PlacedPath, HashMap<McpServerName, McpServerBindingRef>>>,
    /// The provider's bindings in no project root (managed, user, plugin and connector), as its
    /// last inventory read declared them, which a session in no root loads.
    root_free: HashMap<ProviderId, HashMap<McpServerName, McpServerBindingRef>>,
    /// The bindings each provider's accounts declared at the last read that asked them.
    account_declared: HashMap<ProviderId, Vec<McpServerBindingRef>>,
    /// The stamp of the newest read that replaced each provider's bindings.
    applied_stamps: HashMap<ProviderId, u64>,
}

/// Whether a reading asked the provider's accounts, which decides where the table takes the
/// accounts' bindings from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum McpAccountsAsked {
    /// The reading's own account servers replace the accounts' bindings.
    Asked,
    /// The reading asked no account, so the accounts' bindings the last asking read left stand.
    NotAsked,
}

impl McpAttributionTable {
    /// The stamp of a read about to start, later than every stamp handed out before it.
    pub(crate) fn stamp_read(&self) -> u64 {
        self.next_read_stamp.fetch_add(1, Ordering::SeqCst)
    }

    /// Holds `leg` until the table's next replacement, which hands it the new bindings.
    pub(crate) fn wait_for_replacement(&self, leg: Weak<dyn McpUnresolvedReports>) {
        lock(&self.waiting_legs.0).push(leg);
    }

    /// Replaces whole what `provider` loads by its own config with what the read stamped `stamp`
    /// says, unless a read stamped later already replaced it, and answers whether it did: at each
    /// root, where a root missing from the reading resolves no provider-loaded name afterwards,
    /// and in no root, from the bindings it declares in a root-free scope. Where a root's list
    /// names a server twice, its first binding stands; where two root-free scopes declare one
    /// name, the scope first in [`ROOT_FREE_SCOPES`] stands; the accounts' bindings come from the
    /// reading where `accounts` says it asked them, else from the last read that did. Each leg
    /// waiting on the table then resolves its held reports again.
    pub(crate) fn replace_provider_loaded(
        &self,
        provider: &ProviderId,
        reading: &ProviderMcpServersReading,
        accounts: McpAccountsAsked,
        stamp: u64,
    ) -> bool {
        let loaded = reading
            .roots
            .iter()
            .map(|root| {
                let mut names = HashMap::new();
                for binding in &root.provider_loaded {
                    names
                        .entry(McpBindingKey::of(binding).server_name)
                        .or_insert_with(|| binding.clone());
                }
                (root.root.clone(), names)
            })
            .collect();
        {
            let mut roots = lock(&self.roots);
            if roots
                .applied_stamps
                .get(provider)
                .is_some_and(|applied| *applied > stamp)
            {
                return false;
            }
            if accounts == McpAccountsAsked::Asked {
                let account_declared = reading
                    .account_servers
                    .iter()
                    .flat_map(|account| &account.declarations)
                    .map(|declaration| declaration.binding.clone())
                    .collect();
                roots
                    .account_declared
                    .insert(provider.clone(), account_declared);
            }
            let declared: Vec<&McpServerBindingRef> = reading
                .declarations
                .iter()
                .map(|declaration| &declaration.binding)
                .chain(roots.account_declared.get(provider).into_iter().flatten())
                .collect();
            let mut root_free = HashMap::new();
            for scope in ROOT_FREE_SCOPES {
                for binding in &declared {
                    let key = McpBindingKey::of(binding);
                    if key.scope == scope {
                        root_free
                            .entry(key.server_name)
                            .or_insert_with(|| (*binding).clone());
                    }
                }
            }
            roots.applied_stamps.insert(provider.clone(), stamp);
            roots.provider_loaded.insert(provider.clone(), loaded);
            roots.root_free.insert(provider.clone(), root_free);
        }
        let waiting = std::mem::take(&mut *lock(&self.waiting_legs.0));
        for leg in waiting.iter().filter_map(Weak::upgrade) {
            leg.resolve_again();
        }
        true
    }

    /// The binding `server_name` resolves to in a session of `provider` at `root`: the daemon's
    /// sent set first, then what the provider loads there; in a session with no root, the
    /// provider's root-free binding of that name. `None` for a name none of them holds, which
    /// never falls back to another root's or scope's binding.
    pub fn resolve(
        &self,
        provider: &ProviderId,
        root: Option<&PlacedPath>,
        server_name: &McpServerName,
    ) -> Option<McpServerBindingRef> {
        let roots = lock(&self.roots);
        match root {
            Some(root) => [&roots.sent, &roots.provider_loaded]
                .into_iter()
                .find_map(|bindings| bindings.get(provider)?.get(root)?.get(server_name)),
            None => roots.root_free.get(provider)?.get(server_name),
        }
        .cloned()
    }
}

#[cfg(test)]
mod tests {
    use sidekicks_contracts::free_form_string::FilesystemPath;
    use sidekicks_contracts::mcp::server::config::McpServerConfigView;
    use sidekicks_contracts::mcp::server::{McpApprovalMode, McpServerBindingRef, McpServerName};
    use sidekicks_contracts::place::PlacedPath;
    use sidekicks_contracts::provider::id::ProviderId;
    use sidekicks_provider::driver::mcp_server::read::{
        McpRootReading, McpServerDeclaration, McpServerPolicy, McpServerToolDefaults,
        ProviderMcpServersReading,
    };

    use super::{McpAccountsAsked, McpAttributionTable};

    fn root(path: &str) -> PlacedPath {
        PlacedPath {
            path: FilesystemPath::new(path.to_owned()).expect("a test path is a path"),
            place: None,
        }
    }

    fn server_name(name: &str) -> McpServerName {
        McpServerName::new(name.to_owned()).expect("a server name")
    }

    fn project_binding(
        provider: &ProviderId,
        root: &PlacedPath,
        name: &str,
    ) -> McpServerBindingRef {
        McpServerBindingRef::Project {
            provider: provider.clone(),
            scope_ref: root.path.clone(),
            place: None,
            server_name: server_name(name),
        }
    }

    fn declaration(binding: McpServerBindingRef) -> McpServerDeclaration {
        McpServerDeclaration {
            binding,
            config: McpServerConfigView::Stdio {
                command: "server".to_owned(),
                args: None,
                env_var_names: None,
                enabled: None,
                required: None,
                startup_timeout_sec: None,
                tool_timeout_sec: None,
            },
            superseded_in: Vec::new(),
            disabled_in: Vec::new(),
            is_read_only: false,
            sign_in_client: None,
            is_switch_kept_by_daemon: false,
            tool_defaults: McpServerToolDefaults::with_approval_mode(McpApprovalMode::Auto),
            organization_managed: None,
        }
    }

    // A provider's reading of `declarations`, with each of `roots` loading its own `docs` project
    // binding by the provider's own config.
    fn reading(
        provider: &ProviderId,
        roots: &[PlacedPath],
        declarations: Vec<McpServerBindingRef>,
    ) -> ProviderMcpServersReading {
        ProviderMcpServersReading {
            declarations: declarations.into_iter().map(declaration).collect(),
            roots: roots
                .iter()
                .map(|root| McpRootReading {
                    provider_loaded: vec![project_binding(provider, root, "docs")],
                    root: root.clone(),
                    kept_out_server_names: Vec::new(),
                })
                .collect(),
            is_machine_managed: false,
            server_policy: McpServerPolicy::default(),
            account_servers: Vec::new(),
            probe_readings: Vec::new(),
        }
    }

    /// A session in one root attributes a name to that root's binding, never to another root's
    /// same-named one, and a name no binding holds resolves to none. Killed by attributing across
    /// roots, and by inventing a binding for an unknown name.
    #[test]
    fn a_name_resolves_to_its_own_roots_binding_and_an_unknown_name_to_none() {
        let provider = ProviderId::new("provider-a".to_owned()).expect("a provider id");
        let (root_a, root_b) = (root("/repos/a"), root("/repos/b"));
        let table = McpAttributionTable::default();
        table.replace_provider_loaded(
            &provider,
            &reading(&provider, &[root_a.clone(), root_b.clone()], Vec::new()),
            McpAccountsAsked::Asked,
            table.stamp_read(),
        );

        assert_eq!(
            table.resolve(&provider, Some(&root_a), &server_name("docs")),
            Some(project_binding(&provider, &root_a, "docs"))
        );
        assert_eq!(
            table.resolve(&provider, Some(&root_b), &server_name("docs")),
            Some(project_binding(&provider, &root_b, "docs"))
        );
        assert_eq!(
            table.resolve(&provider, Some(&root_a), &server_name("mail")),
            None
        );
    }

    /// A session in no root, a chat, attributes a name to the provider's `user` binding of it,
    /// never to a project's binding of the same or another name, and a name an administrator
    /// declares too to the administrator's; a session in a root keeps its root's binding. Killed
    /// by no resolve without a root, by a root-free resolve that takes a project's binding, and
    /// by the person's binding taking a name over the administrator's.
    #[test]
    fn a_name_reported_in_no_root_resolves_to_the_providers_user_binding() {
        let provider = ProviderId::new("provider-a".to_owned()).expect("a provider id");
        let root_a = root("/repos/a");
        let user_docs = McpServerBindingRef::User {
            provider: provider.clone(),
            server_name: server_name("docs"),
        };
        let [user_tracker, managed_tracker] = [
            McpServerBindingRef::User {
                provider: provider.clone(),
                server_name: server_name("tracker"),
            },
            McpServerBindingRef::Managed {
                provider: provider.clone(),
                server_name: server_name("tracker"),
            },
        ];
        let table = McpAttributionTable::default();
        table.replace_provider_loaded(
            &provider,
            &reading(
                &provider,
                std::slice::from_ref(&root_a),
                vec![
                    user_tracker,
                    managed_tracker.clone(),
                    user_docs.clone(),
                    project_binding(&provider, &root_a, "docs"),
                    project_binding(&provider, &root_a, "mail"),
                ],
            ),
            McpAccountsAsked::Asked,
            table.stamp_read(),
        );

        assert_eq!(
            table.resolve(&provider, None, &server_name("docs")),
            Some(user_docs)
        );
        assert_eq!(table.resolve(&provider, None, &server_name("mail")), None);
        assert_eq!(
            table.resolve(&provider, None, &server_name("tracker")),
            Some(managed_tracker)
        );
        assert_eq!(
            table.resolve(&provider, Some(&root_a), &server_name("docs")),
            Some(project_binding(&provider, &root_a, "docs"))
        );
    }
}
