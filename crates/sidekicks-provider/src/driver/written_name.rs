//! How a provider writes a name in text: the forms a command, a skill, an agent and a tool
//! server's tool or prompt take when the provider writes one, which each driver declares.

/// What a written name names.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WrittenNameKind {
    /// A command the provider runs.
    Command,
    /// A skill.
    Skill,
    /// An agent definition.
    Agent,
    /// A tool a tool server offers.
    ToolServerTool,
    /// A prompt a tool server offers.
    ToolServerPrompt,
}

/// How a form spells the tool server's name.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ServerNameSpelling {
    /// As the server is configured.
    AsConfigured,
    /// Each character outside `A-Za-z0-9_-` written as `_`, as a tool name takes it.
    ToolNameSafe,
}

/// One form a provider writes a name of one kind in: the name between an opening and a closing,
/// after the tool server's name and a joiner for the two tool-server kinds.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WrittenNameForm {
    /// What the name names.
    pub kind: WrittenNameKind,
    /// What comes before the name, or before the server's name.
    pub opening: &'static str,
    /// What comes between the server's name and the name; read only for the two tool-server
    /// kinds.
    pub joiner: &'static str,
    /// What comes after the name.
    pub closing: &'static str,
    /// How the server's name is spelled; read only for the two tool-server kinds.
    pub server_spelling: ServerNameSpelling,
}

impl WrittenNameForm {
    /// `name` written in this form: the opening, then `server` spelled as the form spells it and
    /// the joiner where a server is given, then the name and the closing.
    #[must_use]
    pub fn write(&self, server: Option<&str>, name: &str) -> String {
        let mut written = String::from(self.opening);
        if let Some(server) = server {
            match self.server_spelling {
                ServerNameSpelling::AsConfigured => written.push_str(server),
                ServerNameSpelling::ToolNameSafe => {
                    written.extend(server.chars().map(tool_name_safe));
                }
            }
            written.push_str(self.joiner);
        }
        written.push_str(name);
        written.push_str(self.closing);
        written
    }
}

// `character` as a tool name takes it: itself within `A-Za-z0-9_-`, else `_`.
fn tool_name_safe(character: char) -> char {
    if character.is_ascii_alphanumeric() || character == '_' || character == '-' {
        character
    } else {
        '_'
    }
}

#[cfg(test)]
mod tests {
    use rstest::rstest;

    use super::WrittenNameKind;
    use crate::driver::descriptor_of;

    // Killed by the tool-name spelling applied to Claude's `(MCP)` prompt form or missed on an
    // `mcp__` form, by a wrong joiner or closing, and by an agent form given to Codex.
    #[rstest]
    #[case::claude_prompts(
        "claude",
        WrittenNameKind::ToolServerPrompt,
        Some("my.server"),
        "review",
        &["/my.server:review (MCP)", "/mcp__my_server__review"]
    )]
    #[case::claude_tool(
        "claude",
        WrittenNameKind::ToolServerTool,
        Some("my.server"),
        "search",
        &["mcp__my_server__search"]
    )]
    #[case::claude_agents(
        "claude",
        WrittenNameKind::Agent,
        None,
        "reviewer",
        &["@agent-reviewer", "@\"reviewer (agent)\""]
    )]
    #[case::codex_skill("codex", WrittenNameKind::Skill, None, "deploy", &["$deploy"])]
    #[case::codex_agents("codex", WrittenNameKind::Agent, None, "reviewer", &[])]
    fn each_provider_writes_a_name_in_its_own_forms(
        #[case] provider_id: &str,
        #[case] kind: WrittenNameKind,
        #[case] server: Option<&str>,
        #[case] name: &str,
        #[case] expected: &[&str],
    ) {
        let descriptor = descriptor_of(provider_id).expect("the provider is registered");

        let written: Vec<String> = descriptor
            .written_name_forms
            .iter()
            .filter(|form| form.kind == kind)
            .map(|form| form.write(server, name))
            .collect();

        assert_eq!(written, expected);
    }
}
