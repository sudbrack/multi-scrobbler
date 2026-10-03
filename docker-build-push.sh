#!/usr/bin/env bash
set -euo pipefail

IMAGE_TAG="${IMAGE_TAG:-andrewsuds/multi-scrobbler:replays.2}"
PLATFORM="${PLATFORM:-linux/amd64}"
APP_VERSION="${APP_VERSION:-replays.2}"
BUILD_DATE="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

# Project root directory (location of this script)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "=========================================="
echo " Building and Pushing Multi-Scrobbler"
echo " Image:      ${IMAGE_TAG}"
echo " Platform:   ${PLATFORM}"
echo " Version:    ${APP_VERSION}"
echo " Build Date: ${BUILD_DATE}"
echo "=========================================="

# Ensure docker daemon is accessible
if ! docker info >/dev/null 2>&1; then
    echo "Error: Docker daemon is not running or not accessible." >&2
    exit 1
fi

# Ensure buildx is available
if ! docker buildx version >/dev/null 2>&1; then
    echo "Error: 'docker buildx' is required for cross-platform builds." >&2
    exit 1
fi

echo "Building and pushing image..."
docker buildx build --no-cache \
    --platform "${PLATFORM}" \
    --build-arg APP_BUILD_VERSION="${APP_VERSION}" \
    --build-arg BUILD_DATE="${BUILD_DATE}" \
    -t "${IMAGE_TAG}" \
    --push \
    "$@" \
    .

echo "=========================================="
echo " Successfully built and pushed ${IMAGE_TAG}!"
echo "=========================================="
