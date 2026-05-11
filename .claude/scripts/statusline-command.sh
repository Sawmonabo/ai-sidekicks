#!/usr/bin/env bash
# Claude Code status line — elegant, modern, information-dense
# Reads JSON from stdin and prints a single formatted line.

input=$(cat)

# ── Extract fields ────────────────────────────────────────────────────────────
model=$(echo "$input"        | jq -r '.model.display_name // "Claude"')
cwd=$(echo "$input"          | jq -r '.workspace.current_dir // .cwd // ""')
used_pct=$(echo "$input"     | jq -r '.context_window.used_percentage // empty')
remaining_pct=$(echo "$input"| jq -r '.context_window.remaining_percentage // empty')
vim_mode=$(echo "$input"     | jq -r '.vim.mode // empty')
git_worktree=$(echo "$input" | jq -r '.workspace.git_worktree // empty')
five_h=$(echo "$input"       | jq -r '.rate_limits.five_hour.used_percentage // empty')
seven_d=$(echo "$input"      | jq -r '.rate_limits.seven_day.used_percentage // empty')
output_style=$(echo "$input" | jq -r '.output_style.name // empty')

# ── ANSI helpers ──────────────────────────────────────────────────────────────
reset="\033[0m"
bold="\033[1m"

# Palette (256-colour)
c_blue="\033[38;5;75m"      # steel blue  — model / main info
c_cyan="\033[38;5;80m"      # teal        — directory
c_green="\033[38;5;114m"    # sage green  — healthy / low usage
c_yellow="\033[38;5;221m"   # warm yellow — mid usage warning
c_red="\033[38;5;204m"      # coral red   — high usage / rate limit
c_gray="\033[38;5;245m"     # mid gray    — separators / meta
c_gold="\033[38;5;178m"     # gold        — session name
c_dimgray="\033[38;5;240m"  # dim gray    — output-style annotation
c_lime="\033[38;5;156m"     # lime        — vim INSERT
c_orange="\033[38;5;215m"   # orange      — vim NORMAL

sep_pipe=$(printf "%b│%b" "$c_gray" "$reset")

# ── Helpers ───────────────────────────────────────────────────────────────────

# Collapse $HOME to ~
shorten_path() {
  local p="$1"
  local home="$HOME"
  if [[ "$p" == "$home"* ]]; then
    p="~${p#"$home"}"
  fi
  # Keep at most 4 path components
  local parts depth
  IFS='/' read -ra parts <<< "$p"
  depth=${#parts[@]}
  if (( depth > 5 )); then
    printf "…/%s/%s/%s/%s" "${parts[-4]}" "${parts[-3]}" "${parts[-2]}" "${parts[-1]}"
  else
    echo "$p"
  fi
}

# Thin bar: 10 segments, filled/empty
context_bar() {
  local pct="${1:-0}"
  local filled=$(( pct * 10 / 100 ))
  (( filled > 10 )) && filled=10
  local empty=$(( 10 - filled ))
  local color
  if   (( pct >= 85 )); then color="$c_red"
  elif (( pct >= 60 )); then color="$c_yellow"
  else                       color="$c_green"
  fi
  local bar=""
  for (( i=0; i<filled; i++ )); do bar+="▪"; done
  for (( i=0; i<empty;  i++ )); do bar+="·"; done
  printf "%b%s%b" "$color" "$bar" "$reset"
}

# Colour-coded percentage number
pct_color() {
  local pct="${1:-0}"
  local color
  if   (( pct >= 85 )); then color="$c_red"
  elif (( pct >= 60 )); then color="$c_yellow"
  else                       color="$c_green"
  fi
  printf "%b%.0f%%%b" "$color" "$pct" "$reset"
}

# ── Build segments ────────────────────────────────────────────────────────────
parts=()

# 1. Model name (+ optional output style)
if [[ -n "$output_style" && "$output_style" != "default" ]]; then
  style_lower=$(echo "$output_style" | tr '[:upper:]' '[:lower:]')
  parts+=( "$(printf "%b%b%s%b %b· %s%b" "$bold" "$c_blue" "$model" "$reset" "$c_dimgray" "$style_lower" "$reset")" )
else
  parts+=( "$(printf "%b%b%s%b" "$bold" "$c_blue" "$model" "$reset")" )
fi

# 2. Git worktree (if in one)
if [[ -n "$git_worktree" ]]; then
  parts+=( "$(printf "%b⎇ %s%b" "$c_gold" "$git_worktree" "$reset")" )
fi

# 3. Working directory
if [[ -n "$cwd" ]]; then
  short=$(shorten_path "$cwd")
  parts+=( "$(printf "%b%s%b" "$c_cyan" "$short" "$reset")" )
fi

# 4. Current git branch (if in a git repo; falls back to short SHA on detached HEAD)
if [[ -n "$cwd" ]]; then
  branch=$(git -C "$cwd" branch --show-current 2>/dev/null)
  [[ -z "$branch" ]] && branch=$(git -C "$cwd" rev-parse --short HEAD 2>/dev/null)
  if [[ -n "$branch" ]]; then
    parts+=( "$(printf "%b⎇ %s%b" "$c_gold" "$branch" "$reset")" )
  fi
fi

# 5. Context window
if [[ -n "$used_pct" && -n "$remaining_pct" ]]; then
  bar=$(context_bar "$(printf '%.0f' "$used_pct")")
  num=$(pct_color   "$(printf '%.0f' "$used_pct")")
  parts+=( "$(printf "%bctx%b %s %s" "$c_gray" "$reset" "$bar" "$num")" )
fi

# 6. Rate limits (only when data is present)
if [[ -n "$five_h" || -n "$seven_d" ]]; then
  rl_parts=()
  [[ -n "$five_h"  ]] && rl_parts+=( "$(printf "5h:%s"    "$(pct_color "$(printf '%.0f' "$five_h")")")" )
  [[ -n "$seven_d" ]] && rl_parts+=( "$(printf "week:%s" "$(pct_color "$(printf '%.0f' "$seven_d")")")" )
  joined=$(IFS=" "; echo "${rl_parts[*]}")
  parts+=( "$(printf "%blimits%b %s" "$c_gray" "$reset" "$joined")" )
fi

# 7. Vim mode indicator
if [[ -n "$vim_mode" ]]; then
  if [[ "$vim_mode" == "INSERT" ]]; then
    parts+=( "$(printf "%b%bINSERT%b" "$bold" "$c_lime" "$reset")" )
  else
    parts+=( "$(printf "%b%bNORMAL%b" "$bold" "$c_orange" "$reset")" )
  fi
fi

# ── Assemble and print ────────────────────────────────────────────────────────
# Join with pipe separators
line=""
for (( i=0; i<${#parts[@]}; i++ )); do
  if (( i > 0 )); then
    line+=" $sep_pipe "
  fi
  line+="${parts[$i]}"
done

# Emit the statusline, followed by a line containing a single space so Claude
# Code renders a visible blank row between the statusline and the permissions
# indicator below it. Pure-empty trailing lines are collapsed by some
# renderers, so we use a real (space) character to force the row.
printf "%b%s%b\n \n" "" "$line" "$reset"
