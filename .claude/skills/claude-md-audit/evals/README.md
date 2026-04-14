# claude-md-audit Eval Harness

Automated eval suite for the claude-md-audit skill. Runs tests via `claude -p`, grades results, and produces benchmarks.

## Quick Start

```bash
# Run everything — setup, execute, grade, aggregate
python3 .claude/skills/claude-md-audit/evals/scripts/eval_harness.py full

# Same but with specific model
python3 .claude/skills/claude-md-audit/evals/scripts/eval_harness.py full --model sonnet

# Run only the m32rimm test
python3 .claude/skills/claude-md-audit/evals/scripts/eval_harness.py full --test m32rimm-real-world
```

## Commands

| Command | Description |
|---------|-------------|
| `setup [--iteration N] [--test ID]` | Create workspace for next (or specified) iteration |
| `run [iteration] [--model M] [--test ID]` | Setup + launch all `claude -p` runs in parallel + capture timing |
| `grade [iteration] [--model M]` | Grade each run's report against assertions via `claude -p` |
| `aggregate [iteration]` | Aggregate grading results into `benchmark.json` |
| `full [iteration] [--model M] [--test ID]` | run + grade + aggregate in one command |
| `status [iteration]` | Show pass rates for an iteration (or latest) |

## Options

| Flag | Description | Example |
|------|-------------|---------|
| `--model MODEL` | Claude model passed to `claude -p --model` | `--model sonnet`, `--model opus` |
| `--test ID` | Run only a specific test by ID | `--test m32rimm-real-world` |
| `--iteration N` | Force a specific iteration number | `--iteration 10` |

## Progress Output

The harness polls all running processes and reports completions as they happen:

```
[run] iteration-6: launched 6 runs (model=sonnet)
[run] polling every 5s for completion...

  [1/6] (17%) includes-fixture-baseline: OK in 89s
  [2/6] (33%) ai-foundations-regression-baseline: OK in 142s
  [3/6] (50%) includes-fixture-with-skill: OK in 178s
  ...
  ... 195s elapsed, 2 running: m32rimm, ai
```

## Test Suite

| Test | Assertions | Target |
|------|:-:|---|
| `ai-foundations-regression` | 12 (R1-R12) | Current repo CLAUDE.md + rules |
| `includes-fixture` | 7 (I1-I7) | Bundled test fixture with @AGENTS.md |
| `m32rimm-real-world` | 16 (A1-A16) | External m32rimm repo |

**Total: 35 assertions.** Target: with-skill >=90% per test.

## Artifacts Per Run

Each `{test}-{variant}/` directory contains:

| File | Created By | Contents |
|------|-----------|----------|
| `eval_metadata.json` | `setup` | Prompt + assertions |
| `outputs/report.md` | `run` | The audit report |
| `claude-stdout.txt` | `run` | Raw `claude -p` output |
| `timing.json` | `run` | Execution duration |
| `grading.json` | `grade` | Pass/fail per assertion |

Iteration-level `benchmark.json` is created by `aggregate`.
