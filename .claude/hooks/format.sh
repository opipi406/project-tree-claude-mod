#!/usr/bin/env bash
set -euo pipefail

file_path=$(jq -r '.tool_input.file_path // .tool_response.filePath')
project_dir=$(cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/../..}" && pwd)

case "$file_path" in
  "$project_dir"/*) ;;
  *) exit 0 ;;
esac

cd "$project_dir"
case "$file_path" in
  *.ts | *.tsx | *.mjs) ./node_modules/.bin/eslint --fix "$file_path" ;;
esac
./node_modules/.bin/prettier --write --ignore-unknown --log-level warn "$file_path"
