//! The plan record a plan turn ends with, `plan.proposed`, built the same way from any provider's
//! plan: the plan's own text, its first heading as the title, and the daemon's reading of its
//! top-level steps and the files it names.

use std::collections::HashSet;

use satteri_pulldown_cmark::{Event, LinkType, Options, Parser, Tag, TagEnd};
use sidekicks_contracts::artifacts::id::ArtifactId;
use sidekicks_contracts::plan::{PlanId, PlanProposedPayload};
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::is_ecmascript_whitespace;

use crate::provider::port::plan::ProviderPlan;
use crate::uuid_v7::mint_uuid_v7;

/// The `plan.proposed` payload for `plan`, kept by `artifact_id`, under a freshly minted plan id.
pub(crate) fn compose_plan_proposed_payload(
    plan: ProviderPlan,
    artifact_id: ArtifactId,
) -> PlanProposedPayload {
    let reading = read_plan_markdown(&plan.text);
    let title = reading
        .title
        .unwrap_or_else(|| read_first_line(&plan.text).to_owned());
    PlanProposedPayload {
        plan_id: PlanId::try_from(mint_uuid_v7())
            .expect("a minted UUID is in the text form a plan id takes"),
        session_id: plan.session_id,
        run_id: plan.run_id,
        title,
        text: plan.text,
        step_count: to_count(reading.step_count),
        file_count: to_count(reading.file_count),
        plan_file_path: plan.plan_file_path,
        artifact_id,
        holds_request: plan.holds_request,
    }
}

fn to_count(count: usize) -> SafeInt<0> {
    u64::try_from(count)
        .ok()
        .and_then(SafeInt::new)
        .expect("a count of a plan's parts is far below 2^53")
}

/// What the daemon reads off a plan's markdown.
struct PlanMarkdownReading {
    /// The first top-level heading's text, trimmed; `None` when there is none or it is blank.
    title: Option<String>,
    /// The items of the plan's own lists, not those nested in one; numbered lists alone where it
    /// has any, since bullets beside numbered steps are notes.
    step_count: usize,
    /// The distinct paths the plan names in code spans and in inline links and autolinks.
    file_count: usize,
}

fn read_plan_markdown(text: &str) -> PlanMarkdownReading {
    let mut reader = PlanMarkdownReader::default();
    for event in Parser::new_ext(text, Options::empty()) {
        reader.read_event(&event);
    }
    reader.into_reading()
}

/// One pass over a plan's `CommonMark` events. Reference links are not counted, and neither is
/// anything inside an image's description, which is only the image's alternative text.
#[derive(Default)]
struct PlanMarkdownReader {
    /// How many elements enclose the next event; zero at the top level.
    depth: usize,
    /// How many images enclose the next event.
    image_depth: usize,
    /// The first top-level heading's text so far, once one has started.
    title_heading: Option<String>,
    /// Whether the next event is inside that heading.
    is_reading_title: bool,
    /// Each top-level list: whether it is numbered, and its item count.
    lists: Vec<(bool, usize)>,
    /// The distinct paths named so far.
    paths: HashSet<String>,
}

impl PlanMarkdownReader {
    fn read_event(&mut self, event: &Event<'_>) {
        match event {
            Event::Start(tag) => {
                self.read_start(tag);
                self.depth += 1;
            }
            Event::End(tag_end) => {
                self.depth -= 1;
                if let TagEnd::Heading(_) = tag_end
                    && self.depth == 0
                {
                    self.is_reading_title = false;
                } else if let TagEnd::Image = tag_end {
                    self.image_depth -= 1;
                }
            }
            Event::Text(piece) | Event::InlineHtml(piece) => self.read_title_piece(piece),
            Event::Code(code) => {
                self.read_title_piece(code);
                if self.image_depth == 0 {
                    insert_named_path(&mut self.paths, code);
                }
            }
            Event::SoftBreak => self.read_title_piece("\n"),
            Event::InlineMath(_)
            | Event::DisplayMath(_)
            | Event::Html(_)
            | Event::FootnoteReference(_)
            | Event::HardBreak
            | Event::Rule
            | Event::TaskListMarker(_) => {}
        }
    }

    fn read_start(&mut self, tag: &Tag<'_>) {
        if let Tag::Heading { .. } = tag
            && self.depth == 0
            && self.title_heading.is_none()
        {
            self.title_heading = Some(String::new());
            self.is_reading_title = true;
        } else if let Tag::List(first_number, _) = tag
            && self.depth == 0
        {
            self.lists.push((first_number.is_some(), 0));
        } else if let Tag::Item = tag
            && self.depth == 1
            && let Some((_, item_count)) = self.lists.last_mut()
        {
            *item_count += 1;
        } else if let Tag::Link {
            link_type,
            dest_url,
            ..
        } = tag
            && self.image_depth == 0
            && let Some(destination) = read_link_destination(*link_type, dest_url)
        {
            insert_named_path(&mut self.paths, &destination);
        } else if let Tag::Image { .. } = tag {
            self.image_depth += 1;
        }
    }

    // A heading's text is the text of everything in it, an image's alternative text included.
    fn read_title_piece(&mut self, piece: &str) {
        if self.is_reading_title
            && let Some(title_heading) = self.title_heading.as_mut()
        {
            title_heading.push_str(piece);
        }
    }

    fn into_reading(self) -> PlanMarkdownReading {
        let has_numbered_list = self.lists.iter().any(|(is_numbered, _)| *is_numbered);
        let step_count = self
            .lists
            .iter()
            .filter(|(is_numbered, _)| *is_numbered || !has_numbered_list)
            .map(|(_, item_count)| item_count)
            .sum();
        let title = self
            .title_heading
            .map(|heading| trim_ecmascript_whitespace(&heading).to_owned())
            .filter(|title| !title.is_empty());
        PlanMarkdownReading {
            title,
            step_count,
            file_count: self.paths.len(),
        }
    }
}

// A link's destination as the plan names it; an email autolink reads as its `mailto:` address,
// and a link whose destination is defined elsewhere is not read.
fn read_link_destination(link_type: LinkType, dest_url: &str) -> Option<String> {
    match link_type {
        LinkType::Inline | LinkType::Autolink => Some(dest_url.to_owned()),
        LinkType::Email => Some(format!("mailto:{dest_url}")),
        LinkType::Reference
        | LinkType::ReferenceUnknown
        | LinkType::Collapsed
        | LinkType::CollapsedUnknown
        | LinkType::Shortcut
        | LinkType::ShortcutUnknown
        | LinkType::WikiLink { .. } => None,
    }
}

fn insert_named_path(paths: &mut HashSet<String>, candidate: &str) {
    let candidate = trim_ecmascript_whitespace(candidate);
    if is_named_file_path(candidate) && !paths.contains(candidate) {
        paths.insert(candidate.to_owned());
    }
}

// A path a plan names: no whitespace and no `scheme://` prefix, with a folder or a file extension
// of one to eight ASCII letters and digits.
fn is_named_file_path(candidate: &str) -> bool {
    if has_url_scheme_prefix(candidate) || candidate.chars().any(is_ecmascript_whitespace) {
        return false;
    }
    candidate.contains('/')
        || candidate.rsplit_once('.').is_some_and(|(_, extension)| {
            (1..=8).contains(&extension.len())
                && extension.bytes().all(|byte| byte.is_ascii_alphanumeric())
        })
}

// A lowercase `scheme://` start: a letter, then letters, digits, `+`, `.` or `-`.
fn has_url_scheme_prefix(candidate: &str) -> bool {
    let mut characters = candidate.char_indices();
    if !matches!(characters.next(), Some((_, 'a'..='z'))) {
        return false;
    }
    let scheme_end = characters
        .find(|&(_, character)| !matches!(character, 'a'..='z' | '0'..='9' | '+' | '.' | '-'))
        .map_or(candidate.len(), |(index, _)| index);
    candidate[scheme_end..].starts_with("://")
}

// The plan's first line that is not blank, trimmed; empty when every line is.
fn read_first_line(text: &str) -> &str {
    text.split('\n')
        .map(trim_ecmascript_whitespace)
        .find(|line| !line.is_empty())
        .unwrap_or("")
}

fn trim_ecmascript_whitespace(text: &str) -> &str {
    text.trim_matches(is_ecmascript_whitespace)
}

#[cfg(test)]
mod tests {
    use rstest::rstest;
    use sidekicks_contracts::run::id::RunId;
    use sidekicks_contracts::session::id::SessionId;

    use super::compose_plan_proposed_payload;
    use crate::artifacts::id::mint_artifact_id;
    use crate::provider::port::plan::ProviderPlan;
    use crate::uuid_v7::mint_uuid_v7;

    #[rstest]
    #[case::bullets_count_only_their_top_level_items("- one\n- two\n  - nested\n- three\n", 3, 0)]
    #[case::numbered_steps_win_over_bullet_notes(
        "# Plan\n\n1. one\n2. two\n\n- a note\n- another\n\n3) three\n",
        3,
        0
    )]
    #[case::each_named_path_counts_once(
        "Edit `src/a.rs`, then `src/a.rs` again, `README.md`, [notes](docs/b.md), \
         <https://example.com/c.md>, `not a path` and `v2`.\n",
        0,
        3
    )]
    #[case::numbered_steps_count_past_a_nested_list(
        "1. one\n   1. first part\n   2. second part\n2. two\n   - a note\n3. three\n",
        3,
        0
    )]
    #[case::a_reference_link_is_not_counted(
        "See [the notes][notes], [notes][], [notes] and `src/a.rs`.\n\n[notes]: docs/notes.md\n",
        0,
        1
    )]
    fn plan_markdown_is_read_into_its_counts(
        #[case] markdown: &str,
        #[case] step_count: u64,
        #[case] file_count: u64,
    ) {
        let payload = compose_plan_proposed_payload(
            ProviderPlan {
                session_id: SessionId::try_from(mint_uuid_v7()).expect("a minted UUID"),
                run_id: RunId::try_from(mint_uuid_v7()).expect("a minted UUID"),
                text: markdown.to_owned(),
                plan_file_path: None,
                holds_request: true,
            },
            mint_artifact_id(),
        );
        assert_eq!(payload.step_count.get(), step_count);
        assert_eq!(payload.file_count.get(), file_count);
    }
}
