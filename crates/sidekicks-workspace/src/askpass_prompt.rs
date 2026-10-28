//! The one rule for whether an askpass prompt's answer is typed out of sight, which the clone
//! service's askpass and a command's askpass both read: every answer is masked but git's
//! `Username for '…': ` and ssh's host-key question, `Are you sure you want to continue connecting
//! (yes/no/[fingerprint])? `, since a question no rule knows may ask for a secret.

use std::sync::LazyLock;

use regex::Regex;

/// The prompts whose answer is shown as it is typed; case folds as ASCII only.
static UNMASKED_PROMPT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(?i-u:Username for )|\((?i-u:yes/no)[^)]*\)\? ?$").expect("the pattern is valid")
});

/// Whether the answer to `prompt` is typed out of sight.
pub fn is_masked_prompt(prompt: &str) -> bool {
    !UNMASKED_PROMPT.is_match(prompt)
}

#[cfg(test)]
mod tests {
    use rstest::rstest;

    use super::is_masked_prompt;

    // Fails when the mask is inverted, or when a user name or a host-key choice is taken for a
    // secret.
    #[rstest]
    #[case::password("Password for 'https://ana@github.com': ", true)]
    #[case::ssh_password("ana@build.example.com's password: ", true)]
    #[case::key_passphrase("Enter passphrase for key '/home/ana/.ssh/id_ed25519': ", true)]
    #[case::user_name("Username for 'https://github.com': ", false)]
    #[case::user_name_any_case("USERNAME FOR 'https://github.com': ", false)]
    #[case::host_key(
        "Are you sure you want to continue connecting (yes/no/[fingerprint])? ",
        false
    )]
    fn masks_every_answer_but_a_user_name_or_a_host_key_choice(
        #[case] prompt: &str,
        #[case] is_masked: bool,
    ) {
        assert_eq!(is_masked_prompt(prompt), is_masked);
    }
}
