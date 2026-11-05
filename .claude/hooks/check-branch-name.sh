#!/usr/bin/env bash
set -euo pipefail

cmd=$(jq -r '.tool_input.command // ""')

name=""
if [[ "$cmd" =~ git[[:space:]]+checkout[[:space:]]+-[bB][[:space:]]+([^[:space:]]+) ]]; then
  name="${BASH_REMATCH[1]}"
elif [[ "$cmd" =~ git[[:space:]]+switch[[:space:]]+(-[cC]|--create)[[:space:]]+([^[:space:]]+) ]]; then
  name="${BASH_REMATCH[2]}"
elif [[ "$cmd" =~ git[[:space:]]+branch[[:space:]]+([^-][^[:space:]]*) ]]; then
  name="${BASH_REMATCH[1]}"
fi

if [[ "$name" =~ ^[\&\|\;] ]]; then
  name=""
fi

if [[ -n "$name" && "$name" != develop/* ]]; then
  echo "Blocked: branch name must start with 'develop/' (got: '$name'). See CLAUDE.md." >&2
  exit 2
fi

exit 0
