//! Codex's rule files evaluated the way Codex's own loader evaluates them: each file runs in
//! Starlark's standard environment beside Codex's three builtins, `prefix_rule`, `network_rule`
//! and `host_executable`, which make the checks Codex's builtins make, and once a file has run its
//! rules are held to their examples. A file Codex refuses fails with Codex's own words for it, so
//! what the daemon lists is what Codex enforces, whatever a file computes its rules with.

use std::cell::{RefCell, RefMut};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Instant;

use sidekicks_contracts::approval::{RememberedRuleSense, RememberedScopeKind};
use sidekicks_platforms::PathRules;
use starlark::ErrorKind;
use starlark::any::ProvidesStaticType;
use starlark::environment::{GlobalsBuilder, Module};
use starlark::eval::Evaluator;
use starlark::starlark_module;
use starlark::syntax::{AstModule, Dialect};
use starlark::values::Value;
use starlark::values::list::{ListRef, UnpackList};
use starlark::values::none::NoneType;

use super::normalize_network_rule_host;
use sidekicks_policy::ask_rule::{ProviderAskActionKind, ProviderAskRule};

// The endings Codex strips from a program's name on Windows before it looks the name up.
const WINDOWS_PROGRAM_SUFFIXES: [&str; 4] = [".exe", ".cmd", ".bat", ".com"];

// The most commands one `prefix_rule` call is listed as, one per combination of its words'
// alternatives; past it the call's pattern is listed once, as Codex renders it, so a pattern of many
// alternatives never grows into more commands than memory holds.
const MOST_SPELLED_COMMANDS: usize = 64;

// The most a file's own values may take of the evaluator's heap, a backstop against a file that
// builds values without end; starlark reads it at the same checks as the time limit.
const RULE_EVALUATION_HEAP_LIMIT: usize = 256 * 1024 * 1024;

// The text of starlark's error for an evaluation its cancel check stopped; starlark keeps the
// error's type private, so its text is what tells it apart.
const STARLARK_CANCELED_ERROR: &str = "Evaluation cancelled";

/// Why Codex refuses a rule file, in Codex's own words.
#[derive(Debug, thiserror::Error)]
enum RuleFileError {
    #[error("invalid decision: {0}")]
    InvalidDecision(String),
    #[error("invalid pattern element: {0}")]
    InvalidPattern(String),
    #[error("invalid example: {0}")]
    InvalidExample(String),
    #[error("invalid rule: {0}")]
    InvalidRule(String),
    #[error(
        "expected every example to match at least one rule. rules: {rules:?}; unmatched examples: \
         {examples:?}"
    )]
    ExampleDidNotMatch {
        rules: Vec<String>,
        examples: Vec<String>,
    },
    #[error("expected example to not match rule `{rule}`: {example}")]
    ExampleDidMatch { rule: String, example: String },
    #[error("starlark error: {0}")]
    Starlark(starlark::Error),
}

// What a rule decides, as Codex names it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Decision {
    Allow,
    Prompt,
    Forbidden,
}

impl Decision {
    fn parse(raw: &str) -> Result<Self, RuleFileError> {
        match raw {
            "allow" => Ok(Self::Allow),
            "prompt" => Ok(Self::Prompt),
            "forbidden" => Ok(Self::Forbidden),
            other => Err(RuleFileError::InvalidDecision(other.to_owned())),
        }
    }

    // An allow or a block; a rule Codex asks on is neither.
    fn sense(self) -> Option<RememberedRuleSense> {
        match self {
            Self::Allow => Some(RememberedRuleSense::Allow),
            Self::Forbidden => Some(RememberedRuleSense::Block),
            Self::Prompt => None,
        }
    }
}

// One word of a pattern: a word, or the words it may be. Named and shaped as Codex's, whose
// rendering its refusals quote.
#[derive(Clone, Debug, PartialEq, Eq)]
enum PatternToken {
    Single(String),
    Alts(Vec<String>),
}

impl PatternToken {
    fn alternatives(&self) -> &[String] {
        match self {
            Self::Single(word) => std::slice::from_ref(word),
            Self::Alts(words) => words,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct PrefixPattern {
    first: Arc<str>,
    rest: Arc<[PatternToken]>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct PrefixRule {
    pattern: PrefixPattern,
    decision: Decision,
    justification: Option<String>,
}

impl PrefixRule {
    // The words of `command` the rule matches as a prefix, or `None`.
    fn matches_prefix(&self, command: &[String]) -> Option<Vec<String>> {
        let length = self.rest().len() + 1;
        if command.len() < length || command[0] != *self.pattern.first {
            return None;
        }
        self.rest()
            .iter()
            .zip(&command[1..length])
            .all(|(token, word)| token.alternatives().contains(word))
            .then(|| command[..length].to_vec())
    }

    fn rest(&self) -> &[PatternToken] {
        &self.pattern.rest
    }
}

// A rule matched by an example, as Codex's refusal of a counterexample quotes it.
#[derive(Debug)]
#[expect(
    dead_code,
    reason = "read only through Debug, which Codex's refusal text quotes"
)]
enum RuleMatch {
    PrefixRuleMatch {
        matched_prefix: Vec<String>,
        decision: Decision,
        resolved_program: Option<String>,
        justification: Option<String>,
    },
}

// The examples one `prefix_rule` call names, checked once its file has run.
struct PendingExamples {
    rules: Vec<PrefixRule>,
    matches: Vec<Vec<String>>,
    not_matches: Vec<Vec<String>>,
}

// What the builtins gather while a file runs, carried from one file to the next as Codex carries
// it: the program paths each `host_executable` names stay for the later files' examples. The
// builtins reach it through the evaluator, as Codex's reach its rule builder. `listed` holds the
// file's rules once each, so a file making many rules is not slowed by its duplicates.
struct RuleCollector {
    path_rules: PathRules,
    host_executables: HashMap<String, Vec<String>>,
    pending_examples: Vec<PendingExamples>,
    rules: Vec<ProviderAskRule>,
    listed: HashSet<ProviderAskRule>,
}

/// Evaluates rule files in the order Codex loads them, in a place that spells paths by
/// `path_rules`, an example's relative program path resolved against the session's working folder
/// and one starting `~` against the person's home folder.
pub(super) struct RuleFileEvaluator {
    collector: RefCell<RuleCollector>,
    working_folder: String,
    home_folder: String,
}

impl RuleFileEvaluator {
    /// An evaluator for one load of every rule file.
    pub(super) fn new(path_rules: PathRules, working_folder: String, home_folder: String) -> Self {
        Self {
            collector: RefCell::new(RuleCollector {
                path_rules,
                host_executables: HashMap::new(),
                pending_examples: Vec::new(),
                rules: Vec::new(),
                listed: HashSet::new(),
            }),
            working_folder,
            home_folder,
        }
    }

    /// Runs one file named `file_name` holding `text`, stopped once `deadline` passes, and gives
    /// every allow and block it made. Fails with Codex's words where Codex refuses the file, which
    /// then drops every rule file's rules, and with "did not finish" where the deadline stopped it.
    pub(super) fn evaluate(
        &self,
        file_name: &str,
        text: &str,
        deadline: Instant,
    ) -> Result<Vec<ProviderAskRule>, String> {
        let pending_from = self.collector.borrow().pending_examples.len();
        self.run(file_name, text, deadline)
            .map_err(|error| match &error {
                RuleFileError::Starlark(starlark_error) if is_canceled(starlark_error) => {
                    "did not finish".to_owned()
                }
                RuleFileError::InvalidDecision(_)
                | RuleFileError::InvalidPattern(_)
                | RuleFileError::InvalidExample(_)
                | RuleFileError::InvalidRule(_)
                | RuleFileError::ExampleDidNotMatch { .. }
                | RuleFileError::ExampleDidMatch { .. }
                | RuleFileError::Starlark(_) => error.to_string(),
            })?;
        let collector = self.collector.borrow();
        for pending in &collector.pending_examples[pending_from..] {
            collector
                .check_examples(pending, &self.working_folder, &self.home_folder)
                .map_err(|error| error.to_string())?;
        }
        drop(collector);
        Ok(std::mem::take(&mut self.collector.borrow_mut().rules))
    }

    fn run(&self, file_name: &str, text: &str, deadline: Instant) -> Result<(), RuleFileError> {
        let mut collector = self.collector.borrow_mut();
        collector.rules.clear();
        collector.listed.clear();
        drop(collector);
        let mut dialect = Dialect::Extended.clone();
        dialect.enable_f_strings = true;
        let module = AstModule::parse(file_name, text.to_owned(), &dialect)
            .map_err(RuleFileError::Starlark)?;
        let globals = GlobalsBuilder::standard().with(rule_builtins).build();
        Module::with_temp_heap(|heap_module| {
            let mut evaluator = Evaluator::new(&heap_module);
            evaluator.extra = Some(&self.collector);
            evaluator.set_check_cancelled(Box::new(move || Instant::now() >= deadline));
            evaluator
                .set_max_heap_size(RULE_EVALUATION_HEAP_LIMIT)
                .expect("a new evaluator takes its one heap limit");
            evaluator
                .eval_module(module, &globals)
                .map(|_| ())
                .map_err(RuleFileError::Starlark)
        })
    }
}

#[expect(
    unsafe_code,
    reason = "starlark hands a builtin its context only through this trait"
)]
// SAFETY: the type holds no lifetime, so it is its own type with every lifetime dropped, which is
// all the trait asks; starlark's evaluator hands the builtins this collector through it.
unsafe impl ProvidesStaticType<'_> for RuleCollector {
    type StaticType = Self;
}

// Whether starlark stopped the evaluation at its cancel check; any other error keeps Codex's text.
fn is_canceled(error: &starlark::Error) -> bool {
    matches!(error.kind(), ErrorKind::Other(cause) if cause.to_string() == STARLARK_CANCELED_ERROR)
}

impl RuleCollector {
    fn add(&mut self, rule: ProviderAskRule) {
        if self.listed.insert(rule.clone()) {
            self.rules.push(rule);
        }
    }

    // Codex's check of one call's examples against that call's rules: no counterexample matches,
    // then every example does, a program named by a path reaching the rules on its name.
    fn check_examples(
        &self,
        pending: &PendingExamples,
        working_folder: &str,
        home_folder: &str,
    ) -> Result<(), RuleFileError> {
        for example in &pending.not_matches {
            if let Some(matched) = self
                .match_example(&pending.rules, working_folder, home_folder, example)
                .into_iter()
                .next()
            {
                return Err(RuleFileError::ExampleDidMatch {
                    rule: format!("{matched:?}"),
                    example: render_example(example),
                });
            }
        }
        let unmatched: Vec<String> = pending
            .matches
            .iter()
            .filter(|example| {
                self.match_example(&pending.rules, working_folder, home_folder, example)
                    .is_empty()
            })
            .map(|example| render_example(example))
            .collect();
        if unmatched.is_empty() {
            return Ok(());
        }
        Err(RuleFileError::ExampleDidNotMatch {
            rules: pending
                .rules
                .iter()
                .map(|rule| format!("{rule:?}"))
                .collect(),
            examples: unmatched,
        })
    }

    // The rules an example matches by its program's own word, or else by the name of the program
    // its path names, where any paths a `host_executable` lists for that name hold it.
    fn match_example(
        &self,
        rules: &[PrefixRule],
        working_folder: &str,
        home_folder: &str,
        example: &[String],
    ) -> Vec<RuleMatch> {
        let exact: Vec<RuleMatch> = rules
            .iter()
            .filter_map(|rule| prefix_rule_match(rule, example, None))
            .collect();
        if !exact.is_empty() {
            return exact;
        }
        let Some((program, arguments)) = example.split_first() else {
            return Vec::new();
        };
        let absolute =
            if let Some(expanded) = expand_home_folder(self.path_rules, program, home_folder) {
                expanded
            } else if self.path_rules.is_absolute(program) {
                program.clone()
            } else {
                format!("{working_folder}{}{program}", self.path_rules.separator())
            };
        let Some((normalized, base_name)) = normalize_path(self.path_rules, &absolute) else {
            return Vec::new();
        };
        let key = program_lookup_key(self.path_rules, &base_name);
        if let Some(paths) = self.host_executables.get(&key)
            && !paths.contains(&normalized)
        {
            return Vec::new();
        }
        let by_name: Vec<String> = std::iter::once(key)
            .chain(arguments.iter().cloned())
            .collect();
        rules
            .iter()
            .filter_map(|rule| prefix_rule_match(rule, &by_name, Some(&normalized)))
            .collect()
    }
}

fn rule_collector<'a>(evaluator: &Evaluator<'_, 'a, '_>) -> RefMut<'a, RuleCollector> {
    evaluator
        .extra
        .and_then(|extra| extra.downcast_ref::<RefCell<RuleCollector>>())
        .expect("every rule file runs with its rule collector")
        .borrow_mut()
}

fn prefix_rule_match(
    rule: &PrefixRule,
    command: &[String],
    resolved_program: Option<&String>,
) -> Option<RuleMatch> {
    rule.matches_prefix(command)
        .map(|matched_prefix| RuleMatch::PrefixRuleMatch {
            matched_prefix,
            decision: rule.decision,
            resolved_program: resolved_program.cloned(),
            justification: rule.justification.clone(),
        })
}

// A program path `~` or starting `~` and a separator, read in the home folder, as Codex's absolute
// path type expands it; `None` for any other path.
fn expand_home_folder(path_rules: PathRules, path: &str, home_folder: &str) -> Option<String> {
    let rest = path.strip_prefix('~')?;
    if rest.is_empty() {
        return Some(home_folder.to_owned());
    }
    let is_separator = |character: char| path_rules.is_separator(character);
    let rest = rest.strip_prefix(is_separator)?;
    Some(format!(
        "{home_folder}{}{}",
        path_rules.separator(),
        rest.trim_start_matches(is_separator)
    ))
}

fn render_example(example: &[String]) -> String {
    shlex::try_join(example.iter().map(String::as_str))
        .unwrap_or_else(|_| "unable to render example".to_owned())
}

// A path with `.` and `..` resolved by its words, as Codex makes it absolute, and its last name;
// `None` where no name is left.
fn normalize_path(path_rules: PathRules, path: &str) -> Option<(String, String)> {
    let separator = path_rules.separator();
    let mut words: Vec<&str> = Vec::new();
    let mut is_rooted = false;
    for (index, word) in path
        .split(|character| path_rules.is_separator(character))
        .enumerate()
    {
        match word {
            "" if index == 0 => is_rooted = true,
            "" | "." => {}
            ".." => {
                words.pop();
            }
            word => words.push(word),
        }
    }
    let base_name = (*words.last()?).to_owned();
    let mut normalized = String::with_capacity(path.len());
    if is_rooted {
        normalized.push(separator);
    }
    normalized.push_str(&words.join(&separator.to_string()));
    Some((normalized, base_name))
}

// A program's name as Codex looks it up: on Windows in lower case without its ending.
fn program_lookup_key(path_rules: PathRules, name: &str) -> String {
    if path_rules != PathRules::Windows {
        return name.to_owned();
    }
    let lowered = name.to_ascii_lowercase();
    WINDOWS_PROGRAM_SUFFIXES
        .iter()
        .find_map(|suffix| lowered.strip_suffix(suffix))
        .map_or_else(|| lowered.clone(), ToOwned::to_owned)
}

fn read_pattern(pattern: UnpackList<Value<'_>>) -> Result<Vec<PatternToken>, RuleFileError> {
    let tokens: Vec<PatternToken> = pattern
        .items
        .into_iter()
        .map(read_pattern_token)
        .collect::<Result<_, _>>()?;
    if tokens.is_empty() {
        return Err(RuleFileError::InvalidPattern(
            "pattern cannot be empty".to_owned(),
        ));
    }
    Ok(tokens)
}

fn read_pattern_token(value: Value<'_>) -> Result<PatternToken, RuleFileError> {
    if let Some(word) = value.unpack_str() {
        return Ok(PatternToken::Single(word.to_owned()));
    }
    let Some(list) = ListRef::from_value(value) else {
        return Err(RuleFileError::InvalidPattern(format!(
            "pattern element must be a string or list of strings (got {})",
            value.get_type()
        )));
    };
    let words: Vec<String> = list
        .content()
        .iter()
        .map(|item| {
            item.unpack_str().map(str::to_owned).ok_or_else(|| {
                RuleFileError::InvalidPattern(format!(
                    "pattern alternative must be a string (got {})",
                    item.get_type()
                ))
            })
        })
        .collect::<Result<_, _>>()?;
    match words.as_slice() {
        [] => Err(RuleFileError::InvalidPattern(
            "pattern alternatives cannot be empty".to_owned(),
        )),
        [word] => Ok(PatternToken::Single(word.clone())),
        _ => Ok(PatternToken::Alts(words)),
    }
}

fn read_examples(examples: UnpackList<Value<'_>>) -> Result<Vec<Vec<String>>, RuleFileError> {
    examples.items.into_iter().map(read_example).collect()
}

// An example: a command line split as a shell splits it, or a list of its words; never empty.
fn read_example(value: Value<'_>) -> Result<Vec<String>, RuleFileError> {
    let words = if let Some(line) = value.unpack_str() {
        let words = shlex::split(line).ok_or_else(|| {
            RuleFileError::InvalidExample("example string has invalid shell syntax".to_owned())
        })?;
        if words.is_empty() {
            return Err(RuleFileError::InvalidExample(
                "example cannot be an empty string".to_owned(),
            ));
        }
        words
    } else if let Some(list) = ListRef::from_value(value) {
        let words: Vec<String> = list
            .content()
            .iter()
            .map(|item| {
                item.unpack_str().map(str::to_owned).ok_or_else(|| {
                    RuleFileError::InvalidExample(format!(
                        "example tokens must be strings (got {})",
                        item.get_type()
                    ))
                })
            })
            .collect::<Result<_, _>>()?;
        if words.is_empty() {
            return Err(RuleFileError::InvalidExample(
                "example cannot be an empty list".to_owned(),
            ));
        }
        words
    } else {
        return Err(RuleFileError::InvalidExample(format!(
            "example must be a string or list of strings (got {})",
            value.get_type()
        )));
    };
    Ok(words)
}

fn read_justification(justification: Option<&str>) -> Result<Option<String>, RuleFileError> {
    match justification {
        Some(text) if text.trim().is_empty() => Err(RuleFileError::InvalidRule(
            "justification cannot be empty".to_owned(),
        )),
        Some(text) => Ok(Some(text.to_owned())),
        None => Ok(None),
    }
}

// Whether a pattern names at most `MOST_SPELLED_COMMANDS` commands, counted before any is spelled.
fn is_spelled_out(tokens: &[PatternToken]) -> bool {
    tokens
        .iter()
        .try_fold(1_usize, |count, token| {
            count
                .checked_mul(token.alternatives().len())
                .filter(|count| *count <= MOST_SPELLED_COMMANDS)
        })
        .is_some()
}

// Each command a rule's pattern names, every alternative of every word taken in turn.
fn spell_commands(rule: &PrefixRule) -> Vec<String> {
    let mut commands = vec![rule.pattern.first.to_string()];
    for token in rule.rest() {
        commands = commands
            .iter()
            .flat_map(|prefix| {
                token
                    .alternatives()
                    .iter()
                    .map(move |word| format!("{prefix} {word}"))
            })
            .collect();
    }
    commands
}

// A rule's pattern as Codex renders it, a word of alternatives written `[a|b]`.
fn render_pattern(rule: &PrefixRule) -> String {
    let mut rendered = rule.pattern.first.to_string();
    for token in rule.rest() {
        rendered.push(' ');
        match token {
            PatternToken::Single(word) => rendered.push_str(word),
            PatternToken::Alts(words) => {
                rendered.push('[');
                rendered.push_str(&words.join("|"));
                rendered.push(']');
            }
        }
    }
    rendered
}

// Whether a name the caller found not empty is a bare program name, as Codex holds a
// `host_executable`'s name to be.
fn is_bare_program_name(path_rules: PathRules, name: &str) -> bool {
    name != "."
        && name != ".."
        && !name
            .chars()
            .any(|character| path_rules.is_separator(character))
        && !(path_rules.has_drive_letters() && name.contains(':'))
}

#[starlark_module]
fn rule_builtins(builder: &mut GlobalsBuilder) {
    fn prefix_rule<'v>(
        pattern: UnpackList<Value<'v>>,
        decision: Option<&'v str>,
        r#match: Option<UnpackList<Value<'v>>>,
        not_match: Option<UnpackList<Value<'v>>>,
        justification: Option<&'v str>,
        eval: &mut Evaluator<'v, '_, '_>,
    ) -> anyhow::Result<NoneType> {
        let decision = decision.map_or(Ok(Decision::Allow), Decision::parse)?;
        let justification = read_justification(justification)?;
        let tokens = read_pattern(pattern)?;
        let matches = r#match.map(read_examples).transpose()?.unwrap_or_default();
        let not_matches = not_match
            .map(read_examples)
            .transpose()?
            .unwrap_or_default();
        let (first, rest) = tokens
            .split_first()
            .ok_or_else(|| RuleFileError::InvalidPattern("pattern cannot be empty".to_owned()))?;
        let is_spelled = is_spelled_out(&tokens);
        let rest: Arc<[PatternToken]> = rest.to_vec().into();
        let rules: Vec<PrefixRule> = first
            .alternatives()
            .iter()
            .map(|program| PrefixRule {
                pattern: PrefixPattern {
                    first: Arc::from(program.as_str()),
                    rest: Arc::clone(&rest),
                },
                decision,
                justification: justification.clone(),
            })
            .collect();
        let mut collector = rule_collector(eval);
        if let Some(sense) = decision.sense() {
            for rule in &rules {
                let subjects = if is_spelled {
                    spell_commands(rule)
                } else {
                    vec![render_pattern(rule)]
                };
                for subject in subjects {
                    collector.add(ProviderAskRule {
                        kind: RememberedScopeKind::Project,
                        sense,
                        action: ProviderAskActionKind::Command,
                        subject,
                    });
                }
            }
        }
        collector.pending_examples.push(PendingExamples {
            rules,
            matches,
            not_matches,
        });
        Ok(NoneType)
    }

    fn network_rule<'v>(
        host: &'v str,
        protocol: &'v str,
        decision: &'v str,
        justification: Option<&'v str>,
        eval: &mut Evaluator<'v, '_, '_>,
    ) -> anyhow::Result<NoneType> {
        if !matches!(
            protocol,
            "http" | "https" | "https_connect" | "http-connect" | "socks5_tcp" | "socks5_udp"
        ) {
            return Err(RuleFileError::InvalidRule(format!(
                "network_rule protocol must be one of http, https, socks5_tcp, socks5_udp (got \
                 {protocol})"
            ))
            .into());
        }
        let decision = match decision {
            "deny" => Decision::Forbidden,
            other => Decision::parse(other)?,
        };
        read_justification(justification)?;
        let host = normalize_network_rule_host(host).map_err(RuleFileError::InvalidRule)?;
        if let Some(sense) = decision.sense() {
            rule_collector(eval).add(ProviderAskRule {
                kind: RememberedScopeKind::Project,
                sense,
                action: ProviderAskActionKind::Network,
                subject: host,
            });
        }
        Ok(NoneType)
    }

    fn host_executable<'v>(
        name: &'v str,
        paths: UnpackList<Value<'v>>,
        eval: &mut Evaluator<'v, '_, '_>,
    ) -> anyhow::Result<NoneType> {
        let mut collector = rule_collector(eval);
        let path_rules = collector.path_rules;
        if name.is_empty() {
            return Err(RuleFileError::InvalidRule(
                "host_executable name cannot be empty".to_owned(),
            )
            .into());
        }
        if !is_bare_program_name(path_rules, name) {
            return Err(RuleFileError::InvalidRule(format!(
                "host_executable name must be a bare executable name (got {name})"
            ))
            .into());
        }
        let name_key = program_lookup_key(path_rules, name);
        let mut kept: Vec<String> = Vec::new();
        for value in paths.items {
            let raw = value.unpack_str().ok_or_else(|| {
                RuleFileError::InvalidRule(format!(
                    "host_executable paths must be strings (got {})",
                    value.get_type()
                ))
            })?;
            if !path_rules.is_absolute(raw) {
                return Err(RuleFileError::InvalidRule(format!(
                    "host_executable paths must be absolute (got {raw})"
                ))
                .into());
            }
            let path = normalize_path(path_rules, raw)
                .filter(|(_, base_name)| program_lookup_key(path_rules, base_name) == name_key)
                .map(|(normalized, _)| normalized)
                .ok_or_else(|| {
                    RuleFileError::InvalidRule(format!(
                        "host_executable path `{raw}` must have basename `{name}`"
                    ))
                })?;
            if !kept.contains(&path) {
                kept.push(path);
            }
        }
        collector.host_executables.insert(name_key, kept);
        Ok(NoneType)
    }
}
