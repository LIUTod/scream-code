set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

FLAKE="$ROOT/flake.nix"
FAKE_HASH="sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
CACHE_VERSION="v1"
FETCHER_VERSION="3"
CACHE_FILE="$ROOT/.git/scream-code/pnpm-deps-hashes-$CACHE_VERSION.json"
RESTORE_ORIG_HASH=0

ORIG_HASH="$(grep -E -o 'hash = "sha256-[A-Za-z0-9+/=]+"' "$FLAKE" \
  | head -n 1 \
  | sed -E 's/hash = "(.*)"/\1/')"
if [ -z "$ORIG_HASH" ]; then
  echo "error: could not find pnpmDeps hash in flake.nix" >&2
  exit 1
fi

set_hash() {
  sed -i.bak -E "s|hash = \"sha256-[A-Za-z0-9+/=]+\"|hash = \"$1\"|" "$FLAKE"
  rm -f "$FLAKE.bak"
}

cleanup() {
  if [ "$RESTORE_ORIG_HASH" = "1" ]; then
    set_hash "$ORIG_HASH"
  fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM

hash_stream() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum | sed -E 's/[[:space:]].*$//'
  else
    shasum -a 256 | sed -E 's/[[:space:]].*$//'
  fi
}

hash_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | sed -E 's/[[:space:]].*$//'
  else
    shasum -a 256 "$1" | sed -E 's/[[:space:]].*$//'
  fi
}

print_file_fingerprint() {
  path="$1"
  if [ -f "$path" ]; then
    printf 'file:%s\n' "$path"
    hash_file "$path"
    printf '\n'
  else
    printf 'missing:%s\n' "$path"
  fi
}

input_fingerprint() {
  {
    printf 'cacheVersion=%s\n' "$CACHE_VERSION"
    printf 'fetcherVersion=%s\n' "$FETCHER_VERSION"

    printf 'file:flake.nix(normalized-pnpmDeps-hash)\n'
    sed -E 's|hash = "sha256-[A-Za-z0-9+/=]+"|hash = "sha256-<normalized>"|' "$FLAKE"
    printf '\n'

    for path in \
      .npmrc \
      flake.lock \
      package.json \
      pnpm-lock.yaml \
      pnpm-workspace.yaml
    do
      print_file_fingerprint "$path"
    done

    git ls-files --cached --others --exclude-standard -- \
      '*/package.json' \
      '.pnpmfile.cjs' \
      'patches/**' \
      | sort -u \
      | while IFS= read -r path; do
          [ -n "$path" ] || continue
          [ "$path" = "package.json" ] && continue
          print_file_fingerprint "$path"
        done
  } | hash_stream
}

read_cached_hash() {
  [ -f "$CACHE_FILE" ] || return 0

  # shellcheck disable=SC2016
  node -e '
const fs = require("node:fs");
const [file, key] = process.argv.slice(1);
const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
const entry = parsed[key];
if (entry && typeof entry.hash === "string") {
  console.log(entry.hash);
}
' "$CACHE_FILE" "$INPUT_KEY"
}

write_cached_hash() {
  hash="$1"
  mkdir -p "$(dirname "$CACHE_FILE")"

  # shellcheck disable=SC2016
  node -e '
const fs = require("node:fs");
const [file, key, hash, createdAt] = process.argv.slice(1);
let parsed = {};
try {
  if (fs.existsSync(file)) {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  }
} catch {
  parsed = {};
}
parsed[key] = { hash, createdAt };
fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(parsed, null, 2)}\n`);
fs.renameSync(`${file}.tmp`, file);
' "$CACHE_FILE" "$INPUT_KEY" "$hash" "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
}

echo "==> current pnpmDeps hash: $ORIG_HASH"
INPUT_KEY="$(input_fingerprint)"

if nix build --no-link '.#scream-code-pnpm-deps' >/dev/null 2>&1; then
  write_cached_hash "$ORIG_HASH"
  echo "==> pnpmDeps hash still valid; cached input fingerprint $INPUT_KEY"
  exit 0
fi

echo "==> current hash did not build; checking local pnpmDeps hash cache"
CACHED_HASH=""
if ! CACHED_HASH="$(read_cached_hash)"; then
  echo "warning: ignoring unreadable pnpmDeps hash cache at $CACHE_FILE" >&2
  CACHED_HASH=""
fi

if [ -n "$CACHED_HASH" ] && [ "$CACHED_HASH" != "$ORIG_HASH" ]; then
  echo "==> cache hit for pnpmDeps input: $CACHED_HASH"
  RESTORE_ORIG_HASH=1
  set_hash "$CACHED_HASH"
  if nix build --no-link '.#scream-code-pnpm-deps' >/dev/null 2>&1; then
    RESTORE_ORIG_HASH=0
    write_cached_hash "$CACHED_HASH"
    echo "==> done. pnpmDeps hash: $ORIG_HASH -> $CACHED_HASH"
    exit 0
  fi

  echo "==> cached hash failed verification; falling back to hash discovery"
  set_hash "$ORIG_HASH"
  RESTORE_ORIG_HASH=0
fi

echo "==> patching flake.nix with fakeHash to provoke a mismatch"
RESTORE_ORIG_HASH=1
set_hash "$FAKE_HASH"

echo "==> running nix build to discover the real hash"
BUILD_OUT="$(nix build --no-link --print-build-logs '.#scream-code-pnpm-deps' 2>&1 || true)"

NEW_HASH="$(printf '%s\n' "$BUILD_OUT" \
  | grep -E -o 'got:[[:space:]]+sha256-[A-Za-z0-9+/=]+' \
  | head -n 1 \
  | sed -E 's/^got:[[:space:]]+//')"

if [ -z "$NEW_HASH" ]; then
  echo "error: could not extract a new hash from nix build output." >&2
  echo "----- nix build output -----" >&2
  printf '%s\n' "$BUILD_OUT" >&2
  echo "----- end output -----" >&2
  set_hash "$ORIG_HASH"
  RESTORE_ORIG_HASH=0
  exit 1
fi

set_hash "$NEW_HASH"
RESTORE_ORIG_HASH=0

echo "==> verifying build with new hash"
if ! nix build --no-link '.#scream-code-pnpm-deps'; then
  echo "error: verification build failed after hash update." >&2
  echo "       flake.nix was left pointing at $NEW_HASH for inspection." >&2
  exit 1
fi

write_cached_hash "$NEW_HASH"

if [ "$NEW_HASH" = "$ORIG_HASH" ]; then
  echo "==> hash unchanged ($ORIG_HASH); flake.nix already up to date"
  exit 0
fi

echo "==> done. pnpmDeps hash: $ORIG_HASH -> $NEW_HASH"
