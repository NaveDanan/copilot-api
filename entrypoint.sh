#!/bin/sh
if [ "$1" = "--auth" ]; then
  # Run auth command
  exec bun --use-system-ca run dist/main.js auth
else
  strict_security=false
  for arg in "$@"; do
    case "$arg" in
      --strict-security|--strict-security=true)
        strict_security=true
        break
        ;;
    esac
  done

  # Strict mode removes the token from the long-lived process arguments.
  if [ "$strict_security" = true ] && [ -n "${GH_TOKEN:-}" ]; then
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
  if [ "$strict_security" = false ] && [ -n "${GH_TOKEN:-}" ]; then
    exec bun --use-system-ca run dist/main.js start --github-token "$GH_TOKEN" "$@"
  fi
  exec bun --use-system-ca run dist/main.js start "$@"
fi
