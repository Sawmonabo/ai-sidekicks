//! `session_options`: what a new session can use. It takes no fields, so its arguments are the
//! contracts' `EmptyPayload`, the input every argument-less call shares.

use std::fmt::{self, Write as _};

use sidekicks_contracts::session::controls::methods::PermissionLevel;

use crate::tools::gate::CallbackToolGate;
use crate::tools::session::{ToolDescription, permission_level_words};

/// How `session_options` is gated: it only reads what the calling session may already read.
pub const GATE: CallbackToolGate = CallbackToolGate::Read;

/// What a model reads about `session_options`.
pub const DESCRIPTION: ToolDescription = ToolDescription {
    name: "session_options",
    summary: "List what a new session can use: the person's projects and their branches and \
              groups, the providers and their models and effort levels, the permission levels, \
              and the computers.",
    body: "Call it before session_start when you need a project, branch, model or computer you \
           have not seen named.",
};

/// Everything a new session can be started with.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SessionOptions {
    /// The person's projects.
    pub projects: Vec<ProjectOptions>,
    /// The providers.
    pub providers: Vec<ProviderOptions>,
    /// The permission levels.
    pub permission_levels: Vec<PermissionLevel>,
    /// The person's computers, by name.
    pub computers: Vec<String>,
}

/// One project a new session can work in.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProjectOptions {
    /// The project's name.
    pub name: String,
    /// Its branches.
    pub branches: Vec<String>,
    /// Its session groups.
    pub groups: Vec<String>,
}

/// One provider a new session can run on.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProviderOptions {
    /// The provider's name as the person reads it.
    pub name: String,
    /// Its models.
    pub models: Vec<ModelOptions>,
}

/// One model of a provider.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ModelOptions {
    /// The model's name.
    pub name: String,
    /// Its effort levels; empty for a model with none.
    pub efforts: Vec<String>,
}

impl fmt::Display for ModelOptions {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.name)?;
        if self.efforts.is_empty() {
            return Ok(());
        }
        write!(formatter, " (effort: {})", self.efforts.join(", "))
    }
}

impl fmt::Display for SessionOptions {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let mut lines = Vec::new();
        for project in &self.projects {
            let mut line = format!("project {}", project.name);
            if !project.branches.is_empty() {
                write!(line, " · branches: {}", project.branches.join(", "))?;
            }
            if !project.groups.is_empty() {
                write!(line, " · groups: {}", project.groups.join(", "))?;
            }
            lines.push(line);
        }
        for provider in &self.providers {
            let mut line = format!("provider {}", provider.name);
            for model in &provider.models {
                write!(line, " · {model}")?;
            }
            lines.push(line);
        }
        for &level in &self.permission_levels {
            lines.push(format!(
                "permission level {}",
                permission_level_words(level)
            ));
        }
        for computer in &self.computers {
            lines.push(format!("computer {computer}"));
        }
        formatter.write_str(&lines.join("\n"))
    }
}
