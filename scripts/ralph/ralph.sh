#!/bin/bash
set -euo pipefail

MAX_ITERATIONS="${1:-10}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)"
PRD_FILE="$SCRIPT_DIR/prd.json"
PROGRESS_FILE="$SCRIPT_DIR/progress.txt"
RUNS_DIR="$SCRIPT_DIR/runs"

mkdir -p "$RUNS_DIR"

if [ ! -f "$PROGRESS_FILE" ]; then
  printf '# Ralph Progress Log\nStarted: %s\n---\n' "$(date -u +%FT%TZ)" > "$PROGRESS_FILE"
fi

BRANCH="$(jq -r '.branchName' "$PRD_FILE")"
CURRENT_BRANCH="$(git -C "$PROJECT_ROOT" branch --show-current)"
if [ "$CURRENT_BRANCH" != "$BRANCH" ]; then
  if git -C "$PROJECT_ROOT" show-ref --verify --quiet "refs/heads/$BRANCH"; then
    git -C "$PROJECT_ROOT" switch "$BRANCH"
  else
    git -C "$PROJECT_ROOT" switch -c "$BRANCH"
  fi
fi

for i in $(seq 1 "$MAX_ITERATIONS"); do
  echo "Ralph iteration $i of $MAX_ITERATIONS"
  RUN_LOG="$RUNS_DIR/iteration-${i}.log"
  codex exec -C "$PROJECT_ROOT" --dangerously-bypass-approvals-and-sandbox - < "$SCRIPT_DIR/CODEX.md" > "$RUN_LOG" 2>&1 || true
  if grep -q '<promise>COMPLETE</promise>' "$RUN_LOG"; then
    exit 0
  fi
  tail -n 30 "$RUN_LOG" || true
  if ! jq -e '[.userStories[] | select(.passes == false)] | length > 0' "$PRD_FILE" >/dev/null; then
    echo 'All Ralph stories are complete.'
    exit 0
  fi
  sleep 2
done

echo "Ralph reached the configured limit of $MAX_ITERATIONS iterations."
exit 1
