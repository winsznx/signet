#!/usr/bin/env bash
set -euo pipefail

# Stop hook for the Signet autonomous run.
#
# Blocks termination while docs/run/run-state.json says the run is still working, so the
# agent continues through phases without the user clicking through each one.
#
# Progress watchdog: blocking is only safe while the run is actually advancing. If run-state
# has not changed across STALL_LIMIT consecutive stop attempts, the run is stuck and the hook
# releases so the agent can surface the problem instead of looping forever.

ROOT="${CLAUDE_PROJECT_DIR:-$(pwd)}"
STATE="$ROOT/docs/run/run-state.json"
HANDOFF="$ROOT/docs/run/FINAL_REVIEW_HANDOFF.md"
GUARD="$ROOT/.runtime/stop-hook-guard.json"

STALL_LIMIT=3
HARD_LIMIT=250

# Drain the hook payload so Claude Code never blocks writing to us.
if [[ ! -t 0 ]]; then
  cat > /dev/null || true
fi

# No run state yet means the autonomous run has not established itself. Do not loop.
if [[ ! -f "$STATE" ]]; then
  exit 0
fi

status="$(python3 - "$STATE" <<'PY'
import json, sys
try:
    with open(sys.argv[1], 'r', encoding='utf-8') as f:
        print(json.load(f).get('status', ''))
except Exception:
    print('')
PY
)"

block() {
  printf '%s\n' "$1"
  exit 0
}

# Returns "block" or "release" and updates the guard file.
watchdog() {
  python3 - "$STATE" "$GUARD" "$STALL_LIMIT" "$HARD_LIMIT" <<'PY'
import json, os, sys

state_path, guard_path, stall_limit, hard_limit = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])

def load(path, default):
    try:
        with open(path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return default

state = load(state_path, {})
guard = load(guard_path, {})

# Any field that moves when a phase advances counts as forward progress.
fingerprint = json.dumps(
    {k: state.get(k) for k in ('status', 'currentPhase', 'lastPassingPhase', 'validation', 'updatedAt')},
    sort_keys=True,
)

if guard.get('fingerprint') == fingerprint:
    stalled = int(guard.get('stalled', 0)) + 1
else:
    stalled = 0

total = int(guard.get('total', 0)) + 1

os.makedirs(os.path.dirname(guard_path), exist_ok=True)
with open(guard_path, 'w', encoding='utf-8') as f:
    json.dump({'fingerprint': fingerprint, 'stalled': stalled, 'total': total}, f)

if stalled >= stall_limit:
    print(f'release:run-state has not advanced across {stalled + 1} consecutive stop attempts')
elif total >= hard_limit:
    print(f'release:hook continuation cap of {hard_limit} reached')
else:
    print('block:')
PY
}

case "$status" in
  awaiting_external_input|failed)
    exit 0
    ;;
  ready_for_review)
    if [[ -f "$HANDOFF" ]]; then
      exit 0
    fi
    block '{"decision":"block","reason":"run-state says ready_for_review but docs/run/FINAL_REVIEW_HANDOFF.md is missing. Generate the final handoff before stopping."}'
    ;;
  running)
    verdict="$(watchdog)"
    if [[ "$verdict" == release:* ]]; then
      printf 'Signet stop hook released the run: %s. Review docs/run/run-state.json.\n' "${verdict#release:}" >&2
      exit 0
    fi
    block '{"decision":"block","reason":"The autonomous Signet run is still marked running. Continue with the next PRD phase. Stop only for an explicit hard blocker, a failed central claim, or after Phase 13 passes and FINAL_REVIEW_HANDOFF.md exists. If you are stopping because you are blocked, first set docs/run/run-state.json status to awaiting_external_input or failed with the blocker recorded."}'
    ;;
  *)
    # Unknown state should not create an infinite stop loop. Let Claude stop and surface it.
    exit 0
    ;;
esac
