//! Taking rule calls out of rule files: every byte of each file but the calls kept, the edited
//! texts evaluated together beside the files Codex reads with them, and nothing written unless
//! every edit passes; a file left with no rule is deleted. Both revokes, the settings page's and
//! an approval's, edit files this way.

use std::ops::Range;
use std::path::PathBuf;

use sidekicks_contracts::wire::text::is_ecmascript_whitespace;
use sidekicks_std::file::atomic_write::rewrite_file_in_place;

use super::evaluator::EvaluatedRuleFile;
use super::{
    CODEX_RULE_FILE_MODE, CodexRuleSources, CodexRulesError, evaluate_rule_files,
    read_rule_file_texts, rule_lines,
};

/// One rule file's edit: the file, its text as read under its hold, and the places of the calls
/// taken out of it.
pub(super) struct RuleFileEdit {
    /// The rule file.
    pub(super) path: PathBuf,
    /// Its text as read under its hold.
    pub(super) text: String,
    /// The places of the calls taken out.
    pub(super) spans: Vec<Range<usize>>,
}

/// Takes each edit's calls out of its text, evaluates every edited text together beside the files
/// `sources` reads, and only then writes each file, or deletes one left with no rule line. Refuses
/// with `RevokeRefused`, every file untouched, where an edited file would not load or
/// `still_makes_rule` finds the rule in it; fails with `Unloadable`, every file untouched, where
/// another file does not load, and with `Write` or `Delete` where a file cannot be changed.
pub(super) async fn remove_rule_calls(
    sources: &CodexRuleSources<'_>,
    edits: Vec<RuleFileEdit>,
    still_makes_rule: impl Fn(&EvaluatedRuleFile, &str) -> bool,
) -> Result<(), CodexRulesError> {
    let edited: Vec<(PathBuf, String)> = edits
        .into_iter()
        .map(|edit| {
            let kept = take_out_calls(edit.text, edit.spans);
            (edit.path, kept)
        })
        .collect();
    check_edited_files(sources, &edited, still_makes_rule).await?;
    for (path, kept) in edited {
        if rule_lines(&kept).next().is_none() {
            tokio::fs::remove_file(&path)
                .await
                .map_err(|failure| CodexRulesError::Delete { path, failure })?;
        } else {
            rewrite_file_in_place(&path, kept, CODEX_RULE_FILE_MODE)
                .await
                .map_err(CodexRulesError::Write)?;
        }
    }
    Ok(())
}

// `text` with the calls at `spans` taken out, each with its whole lines where nothing else is on
// them.
fn take_out_calls(mut text: String, mut spans: Vec<Range<usize>>) -> String {
    spans.sort_by_key(|span| std::cmp::Reverse(span.start));
    for span in spans {
        let extent = call_extent(&text, span);
        text.replace_range(extent, "");
    }
    text
}

// Evaluates the files `sources` reads with each of `edited` in place of its file's text, as Codex
// would load them once they are written; refuses with `RevokeRefused` where an edited file does
// not load or `still_makes_rule` finds the rule in it, and fails with `Unloadable` where another
// file does not load.
async fn check_edited_files(
    sources: &CodexRuleSources<'_>,
    edited: &[(PathBuf, String)],
    still_makes_rule: impl Fn(&EvaluatedRuleFile, &str) -> bool,
) -> Result<(), CodexRulesError> {
    let mut files = read_rule_file_texts(sources).await?;
    for file in &mut files {
        if let Some((_, kept)) = edited.iter().find(|(path, _)| *path == file.path) {
            kept.clone_into(&mut file.text);
        }
    }
    for (file, evaluated) in evaluate_rule_files(files, sources).await? {
        let is_edited = edited.iter().any(|(path, _)| *path == file.path);
        let evaluated = match evaluated {
            Ok(evaluated) => evaluated,
            Err(reason) if is_edited => {
                return Err(CodexRulesError::RevokeRefused {
                    path: file.path,
                    reason,
                });
            }
            Err(reason) => {
                return Err(CodexRulesError::Unloadable {
                    path: file.path,
                    reason,
                });
            }
        };
        if is_edited && still_makes_rule(&evaluated, &file.text) {
            return Err(CodexRulesError::RevokeRefused {
                path: file.path,
                reason: "the file still makes the rule".to_owned(),
            });
        }
    }
    Ok(())
}

// The bytes a call's removal takes out of `text`: its whole lines where nothing else is on them,
// else the call alone.
fn call_extent(text: &str, span: Range<usize>) -> Range<usize> {
    let line_start = text[..span.start].rfind('\n').map_or(0, |index| index + 1);
    let line_end = text[span.end..]
        .find('\n')
        .map_or(text.len(), |index| span.end + index + 1);
    let is_alone = text[line_start..span.start]
        .chars()
        .all(is_ecmascript_whitespace)
        && text[span.end..line_end]
            .chars()
            .all(is_ecmascript_whitespace);
    if is_alone { line_start..line_end } else { span }
}
