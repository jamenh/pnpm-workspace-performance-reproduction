#!/bin/bash
# Times a lockfile-only install that adds N new workspace projects, each with one workspace
# dependency, to the committed workspace. Restores the committed state after each run.
# Usage: scripts/new-importers.sh <pnpm executable> [--existing] <N>...
# --existing instead gives N existing projects that same new dependency, as a control.
# Prints one line per N: wall time, resolve_workspace, and whether the lockfile changed.
set -uo pipefail

pnpm="$1"
shift
mode=new
if [[ "${1:-}" == --existing ]]; then mode=existing; shift; fi
cd "$(git rev-parse --show-toplevel)" || exit 1
dir=packages/new-importers

restore() {
	rm -rf "$dir"
	git checkout -q -- pnpm-workspace.yaml pnpm-lock.yaml pnpm-only
}
trap restore EXIT

echo "pnpm $("$pnpm" --version)"
for n in "$@"; do
	restore
	if [[ $mode == existing ]]; then
		for f in $(ls pnpm-only/*/package.json | head -n "$n"); do
			node -e 'const fs = require("fs"), f = process.argv[1], m = JSON.parse(fs.readFileSync(f, "utf8")); m.dependencies["@synth/pkg-00001"] = "workspace:*"; fs.writeFileSync(f, JSON.stringify(m, null, 2) + "\n")' "$f"
		done
	elif (( n > 0 )); then
		perl -0pi -e 's|(  - "packages/registry-consumers/\*"\n)|$1  - "packages/new-importers/*"\n|' pnpm-workspace.yaml
		for i in $(seq -w 1 "$n"); do
			mkdir -p "$dir/new-$i"
			printf '{\n  "name": "@synth/new-%s",\n  "version": "1.0.0",\n  "private": true,\n  "dependencies": {\n    "@synth/pkg-00001": "workspace:*"\n  }\n}\n' "$i" > "$dir/new-$i/package.json"
		done
	fi
	log="$(mktemp)"
	now() { perl -MTime::HiRes=time -e 'printf "%.2f", time'; }
	start=$(now)
	TRACE=pacquet::install::phase=info TRACE_FORMAT=json "$pnpm" install --lockfile-only --trust-lockfile --prefer-offline --ignore-scripts --reporter=append-only > "$log" 2>&1
	rc=$?
	secs=$(awk "BEGIN { printf \"%.2f\", $(now) - $start }")
	resolve=$(grep -o '"phase":"resolve_workspace"[^}]*"elapsed_ms":[0-9]*' "$log" | grep -o '[0-9]*$' | awk '{s += $1} END {printf "%.1f", s / 1000}')
	changed=$(git diff --quiet -- pnpm-lock.yaml && echo no || echo yes)
	echo "$mode=$n rc=$rc wall=${secs}s resolve_workspace=${resolve}s lockfile_changed=$changed"
	(( rc == 0 )) || tail -20 "$log"
	rm -f "$log"
done
