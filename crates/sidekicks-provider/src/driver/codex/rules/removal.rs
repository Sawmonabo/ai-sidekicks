//! Taking rule calls out of one rule file: every byte of the file but the calls kept, the edited
//! text evaluated beside the files Codex reads with it before it is written, and the file deleted
//! once it holds no rule. Both revokes, the settings page's and an approval's, edit a file this
//! way.

use std::ops::Range;
use std::path::Path;

use sidekicks_contracts::wire::text::is_ecmascript_whitespace;
use sidekicks_std::file::atomic_write::rewrite_file_in_place;

use super::evaluator::EvaluatedRuleFile;
use super::{
    CODEX_RULE_FILE_MODE, CodexRuleSources, CodexRulesError, evaluate_rule_files,
    read_rule_file_texts, rule_lines,
};

/// Takes the calls at `spans` out of `text`, the file at `path` as read under its hold, and
/// writes what is left, or deletes the file where no rule line is left. Refuses with
/// `RevokeRefused`, the file untouched, where the edited file would not load beside the files
/// `sources` reads or `still_makes_rule` finds the rule in it; fails with `Unloadable` where
/// another file does not load, and with `Write` or `Delete` where the file cannot be changed.
pub(super) async fn remove_rule_calls(
    sources: &CodexRuleSources<'_>,
    path: &Path,
    text: &str,
    spans: &[Range<usize>],
    still_makes_rule: impl Fn(&EvaluatedRuleFile, &str) -> bool,
) -> Result<(), CodexRulesError> {
    let mut kept = text.to_owned();
    let mut spans = spans.to_vec();
    spans.sort_by_key(|span| std::cmp::Reverse(span.start));
    for span in spans {
        let extent = call_extent(&kept, span);
        kept.replace_range(extent, "");
    }
    if rule_lines(&kept).next().is_none() {
        return tokio::fs::remove_file(path)
            .await
            .map_err(|failure| CodexRulesError::Delete {
                path: path.to_path_buf(),
                failure,
            });
    }
    check_edited_file(sources, path, &kept, still_makes_rule).await?;
    rewrite_file_in_place(path, kept, CODEX_RULE_FILE_MODE)
        .await
        .map_err(CodexRulesError::Write)
}

// Evaluates the files `sources` reads with `edited` in place of `path`'s text, as Codex would load
// them once it is written; refuses with `RevokeRefused` where the edited file does not load or
// `still_makes_rule` finds the rule in it, and fails with `Unloadable` where another file does
// not load.
async fn check_edited_file(
    sources: &CodexRuleSources<'_>,
    path: &Path,
    edited: &str,
    still_makes_rule: impl Fn(&EvaluatedRuleFile, &str) -> bool,
) -> Result<(), CodexRulesError> {
    let mut files = read_rule_file_texts(sources).await?;
    for file in &mut files {
        if file.path == path {
            edited.clone_into(&mut file.text);
        }
    }
    for (file, evaluated) in evaluate_rule_files(files, sources).await? {
        let is_edited = file.path == path;
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
