//! `session_options`' handler: the person's active projects with their branches and groups, each
//! provider with the models and efforts its current account offers, the permission levels and the
//! computers.

use std::collections::BTreeMap;

use futures::future::try_join_all;
use sidekicks_agent::tools::session::options::{
    ModelOptions, ProjectOptions, ProviderOptions, SessionOptions,
};
use sidekicks_contracts::project::ProjectState;
use sidekicks_contracts::repo::mount::RepoMountId;
use sidekicks_contracts::session::controls::methods::PermissionLevel;
use sidekicks_provider::driver::contract::params_and_results::ListModelsParams;
use sidekicks_provider::driver::registry::ProviderRegistry;
use sidekicks_store::database::connection::read_pool::{DatabaseReadPool, ReadLength};
use sidekicks_store::machine::local::read_local_machine;
use sidekicks_workspace::git::worktree::branch_list::BranchListReader;
use sidekicks_workspace::schema::MountOrigin;
use strum::VariantArray as _;

use crate::agent_tools::AgentToolError;

// One active project's name, the folder the person attached for it and its groups' names.
struct ProjectRow {
    name: String,
    mount_id: Option<String>,
    groups: Vec<String>,
}

/// `session_options`: everything a new session can be started with, as its contract prints it.
/// Fails as a read of the projects, a project's branches, a provider's models or this computer
/// fails.
pub(crate) async fn list_session_options(
    pool: &DatabaseReadPool,
    branches: &BranchListReader,
    providers: &ProviderRegistry,
) -> Result<String, AgentToolError> {
    let project_rows = read_project_rows(pool).await?;
    let projects = try_join_all(project_rows.into_iter().map(|project| async move {
        let branch_names = match &project.mount_id {
            None => Vec::new(),
            Some(mount_id) => {
                let mount_id = RepoMountId::new(mount_id).map_err(AgentToolError::failed)?;
                branches
                    .read(&mount_id)
                    .await
                    .map_err(AgentToolError::failed)?
                    .branches
                    .into_iter()
                    .map(|branch| branch.name.as_str().to_owned())
                    .collect()
            }
        };
        Ok::<_, AgentToolError>(ProjectOptions {
            name: project.name,
            branches: branch_names,
            groups: project.groups,
        })
    }))
    .await?;
    let provider_options = try_join_all(providers.drivers().map(|(provider, driver)| async move {
        let models = driver
            .list_models(ListModelsParams {
                session_id: None,
                provider_account_id: None,
            })
            .await
            .map_err(AgentToolError::failed)?;
        let name = providers
            .descriptor(provider)
            .map_err(AgentToolError::failed)?
            .name();
        Ok::<_, AgentToolError>(ProviderOptions {
            name: name.to_owned(),
            models: models
                .into_iter()
                .map(|model| ModelOptions {
                    name: model.name.as_str().to_owned(),
                    efforts: model
                        .effort_levels
                        .unwrap_or_default()
                        .iter()
                        .map(|effort| effort.as_str().to_owned())
                        .collect(),
                })
                .collect(),
        })
    }))
    .await?;
    let machine = read_local_machine(pool)
        .await
        .map_err(AgentToolError::failed)?;
    let options = SessionOptions {
        projects,
        providers: provider_options,
        permission_levels: PermissionLevel::VARIANTS.to_vec(),
        computers: machine.into_iter().map(|machine| machine.name).collect(),
    };
    Ok(options.to_string())
}

// The active projects by name, each with its attached folder and its groups, in one read.
async fn read_project_rows(pool: &DatabaseReadPool) -> Result<Vec<ProjectRow>, AgentToolError> {
    let active = <&'static str>::from(ProjectState::Active);
    let attached = <&'static str>::from(MountOrigin::Attached);
    let sql = format!(
        "SELECT project.name, project.id,
                (SELECT mount.id FROM repo_mounts AS mount
                  WHERE mount.project_id = project.id AND mount.origin = '{attached}'
                  ORDER BY mount.rowid LIMIT 1),
                session_group.name
           FROM projects AS project
           LEFT JOIN session_groups AS session_group ON session_group.project_id = project.id
          WHERE project.state = '{active}'
          ORDER BY project.name, project.id, session_group.name"
    );
    pool.read(ReadLength::Short, move |reader| {
        // Keyed by name then id, so two projects of one name stay two.
        let mut projects: BTreeMap<(String, String), (Option<String>, Vec<String>)> =
            BTreeMap::new();
        let mut statement = reader.prepare(&sql)?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
            ))
        })?;
        for row in rows {
            let (name, id, mount_id, group) = row?;
            let (_, groups) = projects
                .entry((name, id))
                .or_insert_with(|| (mount_id, Vec::new()));
            groups.extend(group);
        }
        Ok::<_, AgentToolError>(
            projects
                .into_iter()
                .map(|((name, _), (mount_id, groups))| ProjectRow {
                    name,
                    mount_id,
                    groups,
                })
                .collect(),
        )
    })
    .await
}
