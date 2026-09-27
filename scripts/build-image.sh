#!/bin/sh
# Build a release bundle from the committed HEAD:
#
#   dist/weight-log-<commit>/
#     image.tar.gz   the container image (docker-archive: `docker load -i` or `podman load -i`)
#     compose.yaml   how to run it (the same file as in the repo)
#     release.env    WEIGHT_LOG_VERSION and WEIGHT_LOG_IMAGE for compose
#
# Uses podman if installed, otherwise docker (override with CONTAINER_ENGINE).
# Deploying a bundle is described in docs/self-hosting.md.
set -eu
cd "$(dirname "$0")/.."

engine=${CONTAINER_ENGINE:-$(command -v podman >/dev/null 2>&1 && echo podman || echo docker)}

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "Uncommitted changes: bundles are built from the committed HEAD only. Commit or stash first." >&2
  exit 1
fi

version=$(git rev-parse --short=12 HEAD)
image=localhost/weight-log:$version
out=dist/weight-log-$version
if [ -e "$out" ]; then
  echo "$out already exists"
  exit 0
fi

mkdir -p dist
tmp=$(mktemp -d dist/.build.XXXXXX)
trap 'rm -rf "$tmp"' EXIT
mkdir "$tmp/src" "$tmp/bundle"
git archive HEAD | tar -x -C "$tmp/src"

if [ "$engine" = podman ]; then
  # docker format keeps the Dockerfile HEALTHCHECK (OCI format drops it)
  podman build --format docker -t "$image" "$tmp/src"
  podman save --format docker-archive "$image" | gzip > "$tmp/bundle/image.tar.gz"
else
  docker build -t "$image" "$tmp/src"
  docker save "$image" | gzip > "$tmp/bundle/image.tar.gz"
fi
cp "$tmp/src/compose.yaml" "$tmp/bundle/compose.yaml"
printf 'WEIGHT_LOG_VERSION=%s\nWEIGHT_LOG_IMAGE=%s\n' "$version" "$image" > "$tmp/bundle/release.env"

mv "$tmp/bundle" "$out"
echo "$out"
