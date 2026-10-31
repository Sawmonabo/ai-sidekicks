//! The two refusals a saved list or pattern meets, in the page's words, for the machine's own
//! settings and a project's override alike: an environment row whose name the shared rule or a
//! provider's driver refuses, and a branch-name pattern refused by its placeholder rule or by git.

use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::machine::settings::{
    EnvironmentNameRefusalReason, EnvironmentRow, ProjectBranchPatternRefusedDetails,
    ProjectEnvironmentNameRefusedDetails, environment_name_refusal,
};
use sidekicks_ipc::domain_error::DomainError;

/// What the page says under a refused row, for each reason.
fn environment_name_refusal_words(reason: EnvironmentNameRefusalReason) -> &'static str {
    match reason {
        EnvironmentNameRefusalReason::NotAName => {
            "A name is letters, digits and underscores, and never starts with a digit."
        }
        EnvironmentNameRefusalReason::CredentialShaped => {
            "Credentials are not set here. Sign in to a provider on Providers, or add a workflow \
             step's token in its Credential field."
        }
        EnvironmentNameRefusalReason::SetByApp => "The app sets this.",
    }
}

/// Refuses with `project.environment.nameRefused` the first row whose name the shared rule
/// refuses, or that names a variable a registered provider's driver sets (`driver_set_names`,
/// compared without case, as Windows reads names), naming the row in the page's words; called
/// before anything is written.
pub fn refuse_environment_rows(
    rows: &[EnvironmentRow],
    driver_set_names: &[&str],
) -> Result<(), DomainError> {
    for row in rows {
        let name = row.name.as_str();
        let reason = environment_name_refusal(name).or_else(|| {
            driver_set_names
                .iter()
                .any(|set_name| set_name.eq_ignore_ascii_case(name))
                .then_some(EnvironmentNameRefusalReason::SetByApp)
        });
        if let Some(reason) = reason {
            let details = ProjectEnvironmentNameRefusedDetails {
                name: row.name.clone(),
                reason,
            };
            return Err(DomainError::new(
                environment_name_refusal_words(reason),
                RefusalCode::ProjectEnvironmentNameRefused,
            )
            .with_detail(details));
        }
    }
    Ok(())
}

/// Refuses with `project.branchPattern.refused` a pattern its check found `refused`, in the page's
/// words, or git's own line for a name that clashes with a branch, the details naming the project
/// whose repository holds it; `None` passes.
pub fn refuse_branch_pattern(
    refused: Option<ProjectBranchPatternRefusedDetails>,
) -> Result<(), DomainError> {
    let Some(details) = refused else {
        return Ok(());
    };
    let message = match &details {
        ProjectBranchPatternRefusedDetails::TitleNotOnce {} => {
            "Put {title} in the name once.".to_owned()
        }
        ProjectBranchPatternRefusedDetails::NotABranchName {} => {
            "Git does not accept this as a branch name.".to_owned()
        }
        ProjectBranchPatternRefusedDetails::ClashesWithBranch { git_message, .. } => {
            git_message.as_str().to_owned()
        }
    };
    Err(DomainError::new(message, RefusalCode::ProjectBranchPatternRefused).with_detail(details))
}
