#!/bin/bash
# Installs readpackage-repeat-install/ from scratch, then reports whether each repeat install takes the
# "Already up to date" fast path, and the reason pnpm logs when it does not. The workspace's pnpmfile
# rewrites `@repeat/consumer`'s `"@repeat/shared": "*"` to `workspace:*`. Restores the committed state on exit.
# Usage: scripts/readpackage-repeat-install.sh <pnpm executable> [--no-rewrite] [rounds]
# --no-rewrite gives `@repeat/consumer` `workspace:*` on disk, so the hook changes nothing, as a control.
set -uo pipefail

pnpm="$1"
shift
mode=rewrite
if [[ "${1:-}" == --no-rewrite ]]; then mode=no-rewrite; shift; fi
rounds="${1:-2}"
cd "$(git rev-parse --show-toplevel)/readpackage-repeat-install" || exit 1
consumer=packages/consumer/package.json

restore() {
	rm -rf node_modules packages/*/node_modules pnpm-lock.yaml
	git checkout -q -- "$consumer"
}
trap restore EXIT
restore

if [[ $mode == no-rewrite ]]; then
	perl -pi -e 's|"\@repeat/shared": "\*"|"\@repeat/shared": "workspace:*"|' "$consumer"
fi

echo "pnpm $("$pnpm" --version) mode=$mode"
"$pnpm" install > /dev/null 2>&1 || { echo 'first install failed'; "$pnpm" install 2>&1 | tail -20; exit 1; }
for round in $(seq "$rounds"); do
	log="$(mktemp)"
	TRACE=pacquet::install=debug TRACE_FORMAT=json "$pnpm" install > "$log" 2>&1
	rc=$?
	verdict=$(grep -o -m1 -e 'Already up to date' -e 'Lockfile is up to date, resolution step is skipped' "$log" || echo '(no verdict)')
	reason=$(grep 'fast path skipped' "$log" | grep -o '"reason":"[^"]*"' | head -1)
	echo "round=$round rc=$rc verdict=\"$verdict\" ${reason}"
	(( rc == 0 )) || tail -20 "$log"
	rm -f "$log"
done
