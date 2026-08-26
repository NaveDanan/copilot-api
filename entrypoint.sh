#!/bin/sh
if [ "$1" = "--auth" ]; then
  # Run auth command
  exec bun --use-system-ca run dist/main.js auth
else
  # Convert Docker's environment secret into the existing protected credential
  # file, then remove it before the long-lived server process starts.
  if [ -n "${GH_TOKEN:-}" ]; then
    token_dir="${COPILOT_API_HOME:-$HOME/.local/share/copilot-api}/${COPILOT_API_OAUTH_APP:-}"
    token_name="github_token"
    if [ -n "${COPILOT_API_ENTERPRISE_URL:-}" ]; then
      token_name="ent_github_token"
    fi
    token_path="$token_dir/$token_name"

    umask 077
    mkdir -p "$token_dir"
    printf '%s' "$GH_TOKEN" > "$token_path"
    chmod 600 "$token_path"
    unset GH_TOKEN
  fi

  # Default command
  exec bun --use-system-ca run dist/main.js start "$@"
fi
