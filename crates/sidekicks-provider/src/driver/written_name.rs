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

/// How a form spells the tool server's name or the name itself.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WrittenNameSpelling {
    /// As the server is configured, or the name declared.
    Unchanged,
    /// Each character outside `A-Za-z0-9_-` written as `_`.
    ToolNameSafe,
    /// Each character outside `A-Za-z0-9_` written as `_`, and an empty one written `_`, as a
    /// Responses API tool name's sanitizer writes it.
    ResponsesToolNameSafe,
}

impl WrittenNameSpelling {
    /// `text` spelled this way, onto the end of `written`.
    pub(crate) fn spell_onto(self, written: &mut String, text: &str) {
        match self {
            Self::Unchanged => written.push_str(text),
            Self::ToolNameSafe => push_safe_characters(written, text, true),
            Self::ResponsesToolNameSafe if text.is_empty() => written.push('_'),
            Self::ResponsesToolNameSafe => push_safe_characters(written, text, false),
        }
    }
}

// Each character of `text` onto `written`: itself within `A-Za-z0-9_`, and `-` too where
// `is_hyphen_kept`, else `_`.
fn push_safe_characters(written: &mut String, text: &str, is_hyphen_kept: bool) {
    written.extend(text.chars().map(|character| {
        if character.is_ascii_alphanumeric()
            || character == '_'
            || (is_hyphen_kept && character == '-')
        {
            character
        } else {
            '_'
        }
    }));
}

/// A provider's own writer of a whole tool-server name, given the server's name and the name, for
/// a provider that cuts or qualifies the name beyond spelling its parts.
pub type WrittenNameFit = fn(server: &str, name: &str) -> String;

/// One form a provider writes a name of one kind in: the name between an opening and a closing,
/// after the tool server's name and a joiner for the two tool-server kinds.
#[derive(Clone, Copy, Debug)]
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
    pub server_spelling: WrittenNameSpelling,
    /// How the name is spelled.
    pub name_spelling: WrittenNameSpelling,
    /// The provider's own writer of the whole name where a server is given, in place of the
    /// opening, spellings, joiner and closing; `None` where those parts write it.
    pub fit: Option<WrittenNameFit>,
}

impl WrittenNameForm {
    /// `name` written in this form: the fit's name where the form has one and a server is given,
    /// else the opening, then `server` spelled as the form spells it and the joiner where a
    /// server is given, then the name spelled as the form spells it and the closing.
    #[must_use]
    pub fn write(&self, server: Option<&str>, name: &str) -> String {
        if let (Some(fit), Some(server)) = (self.fit, server) {
            return fit(server, name);
        }
        let mut written = String::from(self.opening);
        if let Some(server) = server {
            self.server_spelling.spell_onto(&mut written, server);
            written.push_str(self.joiner);
        }
        self.name_spelling.spell_onto(&mut written, name);
        written.push_str(self.closing);
        written
    }
}

#[cfg(test)]
mod tests {
    use rstest::rstest;

    use super::WrittenNameKind;
    use crate::driver::descriptor_of;

    // Killed by the tool-name spelling applied to Claude's `(MCP)` prompt form or missed on an
    // `mcp__` form, by a wrong joiner or closing, by an agent form given to Codex, by Claude's
    // tool name spelled or its server's hyphen dropped, and by Codex's hyphens kept in the server
    // or the tool name.
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
    #[case::claude_hyphenated_tool(
        "claude",
        WrittenNameKind::ToolServerTool,
        Some("my-server"),
        "list-prs",
        &["mcp__my-server__list-prs"]
    )]
    #[case::codex_hyphenated_tool(
        "codex",
        WrittenNameKind::ToolServerTool,
        Some("my-server"),
        "list-prs",
        &["mcp__my_server__list_prs"]
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
