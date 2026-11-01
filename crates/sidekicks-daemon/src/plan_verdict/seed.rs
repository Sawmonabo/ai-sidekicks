//! The seed a plan's fresh session starts from: a fixed opening, the plan's Markdown, then the
//! pointer at the planning conversation's transcript file. A seed that crosses to another provider
//! first loses the writer's own words: each name the planning session knows becomes its
//! description, or goes where it has none, and its attribution, commit-trailer and fixed sandbox
//! and approval lines go whole. The pointer is added after that, so nothing rewrites it.
#![cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the verdict's hand-off composes the fresh session's seed here"
    )
)]

use std::collections::HashMap;
use std::path::Path;

/// The line every seed opens with, on every provider.
const SEED_OPENING: &str = "Implement the following plan:";

/// The pointer sentence up to the transcript file's absolute path.
const POINTER_BEFORE_PATH: &str = "If you need specific details from the planning conversation \
     (like exact code snippets, error messages, or content you generated), read its whole \
     transcript, one plain file at `";

/// The pointer sentence after the transcript file's absolute path.
const POINTER_AFTER_PATH: &str = "`, with your file tools.";

/// The words an attribution line starts with once its leading marks (an emoji, a bullet) are
/// passed.
const ATTRIBUTION_OPENING: &str = "generated with ";

/// The openings a name is written with in text: a command's or skill's sigil, an agent's mention
/// and a tool server's tool.
const WRITTEN_NAME_OPENINGS: [&str; 4] = ["/", "$", "@", "mcp__"];

/// One name the planning session knows, spelled as its provider writes it in text, with what it
/// does.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct WriterName {
    /// The name exactly as the writer's provider writes it, its sigil included: `/review`,
    /// `$deploy`, `@reviewer`, `mcp__github__create_issue`.
    pub(crate) written: String,
    /// What it does; `None` where its source publishes nothing, and the name is then dropped.
    pub(crate) description: Option<String>,
}

/// What a seed crossing to another provider is cleaned of: every name the planning session knows
/// (its skills, agent definitions, tool servers' tools and its provider's own commands) and the
/// fixed sandbox and approval sentences its provider writes.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct WriterVocabulary {
    /// The names, each replaced by its description or dropped.
    pub(crate) names: Vec<WriterName>,
    /// The sentences whose lines are dropped.
    pub(crate) fixed_sentences: Vec<String>,
}

/// Composes a fresh session's seed: the opening, a blank line, the plan's Markdown, a blank line,
/// then the pointer naming `transcript_file`, an absolute path. `crossing` holds the writer's
/// vocabulary when the fresh session runs on another provider, and is `None` on the same one,
/// where the plan goes as written.
pub(crate) fn compose_seed(
    plan_markdown: &str,
    transcript_file: &Path,
    crossing: Option<&WriterVocabulary>,
) -> String {
    let plan = match crossing {
        Some(vocabulary) => rewrite_for_crossing(plan_markdown, vocabulary),
        None => plan_markdown.to_owned(),
    };
    format!(
        "{SEED_OPENING}\n\n{}\n\n{POINTER_BEFORE_PATH}{}{POINTER_AFTER_PATH}",
        plan.trim_end(),
        transcript_file.to_string_lossy()
    )
}

/// The plan with every attribution, commit-trailer and fixed-sentence line dropped and every
/// known name rewritten, code spans and blocks included.
fn rewrite_for_crossing(plan_markdown: &str, vocabulary: &WriterVocabulary) -> String {
    let names = NameIndex::new(&vocabulary.names);
    let fixed_sentences: Vec<&str> = vocabulary
        .fixed_sentences
        .iter()
        .map(|sentence| sentence.as_str().trim())
        .filter(|sentence| !sentence.is_empty())
        .collect();
    let mut rewritten = String::with_capacity(plan_markdown.len());
    for line in plan_markdown.split_inclusive('\n') {
        let is_dropped = is_attribution_or_trailer(line)
            || fixed_sentences
                .iter()
                .any(|sentence| line.contains(sentence));
        if !is_dropped {
            names.rewrite_line(line, &mut rewritten);
        }
    }
    rewritten
}

/// Whether `line` credits a tool (`Generated with …`) or is a `…-by:` commit trailer
/// (`Co-Authored-By:`, `Signed-off-by:`, `Reviewed-by:`).
fn is_attribution_or_trailer(line: &str) -> bool {
    let text = line.trim();
    let words = text.trim_start_matches(|character: char| !character.is_alphanumeric());
    if words
        .get(..ATTRIBUTION_OPENING.len())
        .is_some_and(|opening| opening.eq_ignore_ascii_case(ATTRIBUTION_OPENING))
    {
        return true;
    }
    let Some((token, value)) = text.split_once(':') else {
        return false;
    };
    let mut token_words = token.split('-');
    let is_by_token = token.len() > "-by".len()
        && token
            .get(token.len() - "-by".len()..)
            .is_some_and(|ending| ending.eq_ignore_ascii_case("-by"))
        && token_words
            .all(|word| !word.is_empty() && word.chars().all(|c| c.is_ascii_alphabetic()));
    is_by_token && !value.trim().is_empty()
}

/// The known names by their first character, each list longest first, so the longest name a
/// position starts with wins.
struct NameIndex<'a> {
    by_first_character: HashMap<char, Vec<IndexedName<'a>>>,
}

/// A known name and what replaces it: its description on one line, or nothing.
struct IndexedName<'a> {
    written: &'a str,
    replacement: Option<String>,
}

impl<'a> NameIndex<'a> {
    fn new(names: &'a [WriterName]) -> Self {
        let mut by_written: HashMap<&str, Option<String>> = HashMap::new();
        for name in names {
            let written = name.written.trim();
            if !WRITTEN_NAME_OPENINGS
                .iter()
                .any(|opening| written.len() > opening.len() && written.starts_with(opening))
            {
                // A form no provider writes a name in is refused, so a bare word never rewrites
                // the plan's prose.
                continue;
            }
            // A name two sources list keeps the description either one gives.
            let description = name
                .description
                .as_deref()
                .map(|text| text.split_whitespace().collect::<Vec<_>>().join(" "))
                .filter(|text| !text.is_empty());
            let entry = by_written.entry(written).or_default();
            if entry.is_none() {
                *entry = description;
            }
        }
        let mut by_first_character: HashMap<char, Vec<IndexedName<'a>>> = HashMap::new();
        for (written, replacement) in by_written {
            if let Some(first) = written.chars().next() {
                by_first_character
                    .entry(first)
                    .or_default()
                    .push(IndexedName {
                        written,
                        replacement,
                    });
            }
        }
        for candidates in by_first_character.values_mut() {
            candidates.sort_by_key(|name| std::cmp::Reverse(name.written.len()));
        }
        Self { by_first_character }
    }

    /// Appends `line` to `rewritten` with each known name that stands as a token of its own
    /// replaced by its description, or dropped with one space beside it.
    fn rewrite_line(&self, line: &str, rewritten: &mut String) {
        let mut copied_up_to = 0;
        for (index, character) in line.char_indices() {
            if index < copied_up_to {
                continue;
            }
            let Some(candidates) = self.by_first_character.get(&character) else {
                continue;
            };
            let before = line[..index].chars().next_back();
            if before.is_some_and(is_name_character) {
                continue;
            }
            let rest = &line[index..];
            let Some(name) = candidates.iter().find(|name| {
                rest.starts_with(name.written) && ends_a_name(&rest[name.written.len()..])
            }) else {
                continue;
            };
            rewritten.push_str(&line[copied_up_to..index]);
            copied_up_to = index + name.written.len();
            if let Some(description) = &name.replacement {
                rewritten.push_str(description);
            } else if before.is_none_or(char::is_whitespace)
                && line[copied_up_to..].starts_with(' ')
            {
                // Dropped between two spaces, or at the line's start before one, the space after
                // it goes too, so no double space is left.
                copied_up_to += 1;
            }
        }
        rewritten.push_str(&line[copied_up_to..]);
    }
}

/// Whether `character` continues a name, a path or an address, so a sigil after it starts no
/// name and a name followed by it ends at no token boundary.
fn is_name_character(character: char) -> bool {
    character.is_alphanumeric() || "_-/:@$\\".contains(character)
}

/// Whether `rest`, what follows a matched name, leaves it a whole token: a sentence's full stop
/// ends a name, while a dot before more of a word (`@example.com`) does not.
fn ends_a_name(rest: &str) -> bool {
    let mut characters = rest.chars();
    match characters.next() {
        None => true,
        Some('.') => !characters.next().is_some_and(char::is_alphanumeric),
        Some(next) => !is_name_character(next),
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use rstest::rstest;

    use super::{WriterName, WriterVocabulary, compose_seed};

    const TRANSCRIPT_FILE: &str = "/data/sessions/fresh/planning-transcript.md";

    const POINTER: &str = "If you need specific details from the planning conversation (like \
         exact code snippets, error messages, or content you generated), read its whole \
         transcript, one plain file at `/data/sessions/fresh/planning-transcript.md`, with your \
         file tools.";

    const SANDBOX_SENTENCE: &str = "Commands run inside the workspace sandbox without network.";

    fn known(written: &str, description: Option<&str>) -> WriterName {
        WriterName {
            written: written.to_owned(),
            description: description.map(str::to_owned),
        }
    }

    fn writer_vocabulary() -> WriterVocabulary {
        WriterVocabulary {
            names: vec![
                known("/review", Some("review the current diff")),
                known("$deploy", Some("deploy the  staging\nbuild")),
                known("@reviewer", Some("a reviewing agent")),
                known("mcp__tracker__create_issue", None),
                // The same name from a second source with no description keeps the first's.
                known("/review", None),
                known("/usr", Some("never written")),
                known("@example", Some("never written")),
            ],
            fixed_sentences: vec![SANDBOX_SENTENCE.to_owned()],
        }
    }

    fn seed_of(plan: &str) -> String {
        format!("Implement the following plan:\n\n{plan}\n\n{POINTER}")
    }

    #[test]
    fn same_provider_seed_is_the_opening_the_plan_as_written_and_the_pointer() {
        let plan = "# Plan\n\nRun /review, then $deploy.\nCo-Authored-By: A Writer\n";
        let seed = compose_seed(plan, Path::new(TRANSCRIPT_FILE), None);
        assert_eq!(
            seed,
            seed_of("# Plan\n\nRun /review, then $deploy.\nCo-Authored-By: A Writer")
        );
    }

    #[rstest]
    #[case::f2_slash_name(
        "Run /review before merging.",
        "Run review the current diff before merging."
    )]
    #[case::f2_dollar_name_on_one_line("Then $deploy.", "Then deploy the staging build.")]
    #[case::f2_at_name("(ask @reviewer)", "(ask a reviewing agent)")]
    #[case::f3_known_name_without_description(
        "Then call mcp__tracker__create_issue to file it.",
        "Then call to file it."
    )]
    #[case::f4_unknown_shapes(
        "Copy /usr/bin/env, mail @example.com, pay $5 and see a/review.",
        "Copy /usr/bin/env, mail @example.com, pay $5 and see a/review."
    )]
    #[case::f4_longer_unknown_name("Run /review-all.", "Run /review-all.")]
    #[case::f5_inline_code("Use `/review` here.", "Use `review the current diff` here.")]
    #[case::f5_code_block(
        "```\n$deploy\nmcp__tracker__create_issue\n```",
        "```\ndeploy the staging build\n\n```"
    )]
    #[case::f6_co_authored_by(
        "Step one.\nCo-Authored-By: A Writer\nStep two.",
        "Step one.\nStep two."
    )]
    #[case::f6_generated_with(
        "Step one.\n🤖 Generated with [A Tool](https://tool.test)\n",
        "Step one."
    )]
    #[case::f7_commit_trailer(
        "Step one.\nSigned-off-by: A Writer\n  Reviewed-by: Another",
        "Step one."
    )]
    #[case::f7_prose_with_a_colon_stays("Note: stand-by: keep it.", "Note: stand-by: keep it.")]
    #[case::f8_fixed_sentence(
        "Step one.\n> Commands run inside the workspace sandbox without network.\nStep two.",
        "Step one.\nStep two."
    )]
    fn crossing_seed_follows_table_f(#[case] plan: &str, #[case] rewritten: &str) {
        let vocabulary = writer_vocabulary();
        let seed = compose_seed(plan, Path::new(TRANSCRIPT_FILE), Some(&vocabulary));
        assert_eq!(seed, seed_of(rewritten));
    }
}
