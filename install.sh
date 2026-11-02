#!/usr/bin/env bash
# Installs the `tracker` command and the agent skill. Safe to run again.
#   ./install.sh              install (or repair after you move the clone)
#   ./install.sh --uninstall  remove the command and the skill links
set -euo pipefail

REPO="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="${TRACKER_BIN_DIR:-$HOME/.local/bin}"
# Claude Code reads ~/.claude/skills; Codex and other agents read ~/.agents/skills.
SKILL_DIRS=("$HOME/.claude/skills" "$HOME/.agents/skills")
MIN_NODE="22.15.0"

ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$1" >&2; exit 1; }

# Links $1 -> $2. Replaces an old link; never replaces a real file or folder.
link() {
  local target="$1" path="$2"
  mkdir -p "$(dirname "$path")"
  if [ -L "$path" ] || [ ! -e "$path" ]; then
    ln -sfn "$target" "$path"
    ok "linked $path"
  else
    warn "skipped $path: a file or folder with this name exists. Move it, then run install.sh again."
  fi
}

unlink_ours() {
  local path="$1"
  if [ -L "$path" ] && [[ "$(readlink "$path")" == "$REPO"/* ]]; then
    rm "$path"
    ok "removed $path"
  fi
}

if [ "${1:-}" = "--uninstall" ]; then
  echo "Removing tracker"
  unlink_ours "$BIN_DIR/tracker"
  for d in "${SKILL_DIRS[@]}"; do unlink_ours "$d/tracker"; done
  echo "Done. Your .tracker/ folders in projects are not changed."
  exit 0
fi

echo "Installing tracker from $REPO"

# 1. Node.js with the built-in node:sqlite module.
command -v node >/dev/null 2>&1 || fail "Node.js is not installed. Install Node.js 24 LTS from https://nodejs.org, then run install.sh again."
node_version="$(node -p 'process.versions.node')"
if ! node -e '
  const [a, b] = [process.argv[1], process.argv[2]].map((v) => v.split(".").map(Number));
  process.exit((a[0] - b[0] || a[1] - b[1] || a[2] - b[2]) >= 0 ? 0 : 1);
' "$node_version" "$MIN_NODE"; then
  fail "Node.js $node_version is too old. Install Node.js $MIN_NODE or newer (24 LTS is best), then run install.sh again."
fi
ok "Node.js $node_version"

# 2. The command.
chmod +x "$REPO/bin/tracker"
link "$REPO/bin/tracker" "$BIN_DIR/tracker"

# 3. The skill for coding agents.
for d in "${SKILL_DIRS[@]}"; do link "$REPO/skill" "$d/tracker"; done

# 4. Smoke test in a temporary project.
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
if (cd "$tmp" && "$REPO/bin/tracker" init --prefix TEST >/dev/null && "$REPO/bin/tracker" create --title "smoke test" | grep -q '"key": "TEST-1"'); then
  ok "smoke test passed"
else
  fail "smoke test failed. Run: cd \"$tmp\" && \"$REPO/bin/tracker\" init"
fi

# 5. PATH.
case ":$PATH:" in
  *":$BIN_DIR:"*) ok "$BIN_DIR is on your PATH" ;;
  *)
    case "${SHELL:-}" in
      */zsh) rc="$HOME/.zshrc" ;;
      */bash) rc="$HOME/.bashrc" ;;
      *) rc="your shell startup file" ;;
    esac
    warn "$BIN_DIR is not on your PATH. Add this line to $rc, then open a new terminal:"
    echo "      export PATH=\"$BIN_DIR:\$PATH\""
    ;;
esac

cat <<EOF

Done. Next steps:
  cd your-project
  tracker init          # once per project; makes .tracker/
  tracker ui            # open the board in a browser

Your coding agent (Claude Code, Codex) now has the "tracker" skill.
Ask it, for example: "Use the tracker to plan this feature as tickets."
EOF
