#!/bin/sh
# Entrypoint of the `http` image: supergateway in front of the stdio server,
# with an inbound bearer token.
#
# supergateway can check a key itself (`--apiKey`, constant-time, `/healthz`
# left open) but starts wide open when none is given, and takes one key per
# flag. This script is the missing half: it reads MCP_API_KEYS (comma-separated,
# the name the sibling servers use), refuses to start without it unless
# MCP_ALLOW_NO_AUTH=true says that is meant, and turns each key into a flag.
#
# Keys are never printed — only how many there are. They do appear in this
# process's argument list inside the container, which is as far as a plain
# `--apiKey` goes.
set -eu

keys="${MCP_API_KEYS:-}"
allow_open="${MCP_ALLOW_NO_AUTH:-}"
# Out of the environment before anything is started: the stdio server below
# inherits it, and has no use for the keys.
unset MCP_API_KEYS MCP_ALLOW_NO_AUTH

gateway="${GATEWAY_BIN:-/gateway/node_modules/.bin/supergateway}"
stdio_command="${GATEWAY_STDIO_COMMAND:-node /app/dist/index.js}"

set -- --stdio "$stdio_command" \
  --outputTransport streamableHttp --stateful --sessionTimeout 900000 \
  --port 8000 --healthEndpoint /healthz

count=0
if [ -n "$keys" ]; then
  # Split on commas only, and never let the shell expand a key as a glob.
  set -f
  old_ifs="$IFS"
  IFS=','
  for key in $keys; do
    IFS="$old_ifs"
    # A header value carries no surrounding whitespace, so neither can a key.
    key="$(printf '%s' "$key" | tr -d ' \t\r\n')"
    if [ -n "$key" ]; then
      set -- "$@" "--apiKey=$key"
      count=$((count + 1))
    fi
    IFS=','
  done
  IFS="$old_ifs"
  set +f
  if [ "$count" -eq 0 ]; then
    echo "carddav-mcp: MCP_API_KEYS is set but holds no key (is it only commas or spaces?). Refusing to start." >&2
    exit 1
  fi
  echo "carddav-mcp: bearer authentication required on /mcp ($count key(s)); /healthz stays open." >&2
elif [ "$allow_open" = "true" ]; then
  echo "carddav-mcp: WARNING: MCP_ALLOW_NO_AUTH=true — serving /mcp without authentication." >&2
else
  echo "carddav-mcp: MCP_API_KEYS is not set. Set it to one or more comma-separated bearer tokens, or set MCP_ALLOW_NO_AUTH=true to serve without authentication. Refusing to start." >&2
  exit 1
fi

exec "$gateway" "$@"
