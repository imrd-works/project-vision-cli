# Sourced by the git hooks: `run <command>` runs a hook command where the dependencies are.
#   1. node_modules is installed here (a machine with Node, or inside the dev container): here.
#   2. Otherwise in the dev container that recorded itself on start (git config hooks.devContainer,
#      hooks.devWorkdir): the host of a Docker-only setup has no node_modules.
#   3. Neither: the hook fails. A check never passes without actually running.
run() {
  if [ -d node_modules/.bin ]; then
    "$@"
    return
  fi
  container=$(git config --get hooks.devContainer || true)
  workdir=$(git config --get hooks.devWorkdir || true)
  if [ -n "$container" ] && docker exec "$container" true >/dev/null 2>&1; then
    docker exec -w "$workdir" "$container" "$@"
    return
  fi
  echo "git hooks: cannot run \"$*\": no node_modules here and no running dev container." >&2
  echo "Install dependencies (npm ci) or start the dev stack (npm run dev:up in the backend)." >&2
  return 1
}
