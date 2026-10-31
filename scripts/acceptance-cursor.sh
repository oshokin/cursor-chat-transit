#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/acceptance-cursor.sh [--cursor PATH] [--output DIR] [--allow-mutation]

Creates an evidence file and manual real-Cursor checklist. It is non-destructive:
it does not open Cursor data, run an import/export, or send a message.
--allow-mutation records explicit consent for the operator to perform the manual
continuation step; the script still performs no mutation itself.
EOF
}

cursor_path="${CURSOR_BIN:-}"
output=""
allow_mutation=false

while (($#)); do
  case "$1" in
    --cursor)
      cursor_path="${2:?--cursor requires a path}"
      shift 2
      ;;
    --output)
      output="${2:?--output requires a directory}"
      shift 2
      ;;
    --allow-mutation)
      allow_mutation=true
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -z "$cursor_path" ]]; then
  cursor_path="$(command -v cursor || true)"
fi
if [[ -z "$cursor_path" || ! -f "$cursor_path" ]]; then
  echo "Cursor executable not found; pass --cursor PATH or set CURSOR_BIN." >&2
  exit 1
fi

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
output="${output:-"$repo/acceptance-evidence"}"
mkdir -p "$output"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
report="$output/cursor-acceptance-$stamp.md"
cursor_hash="$(sha256sum "$cursor_path" | awk '{print $1}')"
commit="$(git -C "$repo" rev-parse HEAD)"
dirty="$(git -C "$repo" status --porcelain --untracked-files=no)"
version="$("$cursor_path" --version 2>&1 || true)"

cat >"$report" <<EOF
# Cursor Chat Transit acceptance

- Recorded UTC: $(date -u +%Y-%m-%dT%H:%M:%SZ)
- Cursor executable: \`$cursor_path\`
- Cursor executable SHA-256: \`$cursor_hash\`
- Cursor version output:

\`\`\`text
$version
\`\`\`

- Extension commit: \`$commit\`
- Tracked worktree dirty: $([[ -n "$dirty" ]] && echo yes || echo no)
- Platform: \`$(uname -srm)\`
- Manual mutation authorized: \`$allow_mutation\`

## Non-destructive checks

- [ ] Install the VSIX built from the recorded commit in a disposable profile.
- [ ] Confirm the expected local profile and destination workspace before import.
- [ ] Export a non-sensitive fixture; record Transit's completeness result.
- [ ] Import to a fresh destination; quit and reopen Cursor.
- [ ] Verify text and each fixture resource (image/plan/canvas/subagent) renders.
- [ ] Confirm the source fixture and unrelated destination chats are unchanged.
- [ ] Keep this report and any archive private or redact paths and content.

## Continuation check (manual and destructive)

Authorized above must be \`true\` before this section is performed.

- [ ] Record account/environment: ______________________________
- [ ] Record workspace kind: local / SSH / WSL / container
- [ ] If remote, record actual authority availability; do not infer recreation.
- [ ] Send one disposable new message in the imported copy.
- [ ] Record completed response: yes / no
- [ ] Record observed result and UTC time: ______________________

Passing means only that this copy continued in the exact recorded build and
environment. It does not certify another build, account, chat, machine, or remote
backend.
EOF

chmod 600 "$report"
printf '%s\n' "$report"
