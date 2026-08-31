#!/bin/sh
# -----------------------------------------------------------------------------
# Bucket provisioning (§14) only.
#
# The bucket CORS policy is deliberately NOT set here via `mc cors set`. Per-bucket CORS
# (the S3 PutBucketCors API `mc cors set` calls) is a MinIO AIStor (paid-tier) feature only -
# the open-source Community Edition server this compose file runs does not implement that
# endpoint at any version, so `mc cors set` always fails here with a confusing
# "decoding xml: EOF" (the server has nothing meaningful to reply with). It is not a
# version/build limitation that upgrading `mc` or MinIO would fix.
#
# The correct mechanism for open-source MinIO is server-level, not bucket-level: the
# MINIO_API_CORS_ALLOW_ORIGIN environment variable on the `minio` service itself
# (deploy/docker-compose.yml), set from the same origins list `web` uses for its own CORS
# middleware (spec §9) so the two configurations cannot drift. That variable is read once at
# server startup - this script's only remaining job is making sure the bucket exists.
# -----------------------------------------------------------------------------
set -eu

ENDPOINT="${MINIO_ENDPOINT:-http://minio:9000}"
BUCKET="${MINIO_BUCKET:-images}"

echo "[minio-init] waiting for ${ENDPOINT}"
until mc alias set local "${ENDPOINT}" "${MINIO_ROOT_USER}" "${MINIO_ROOT_PASSWORD}" >/dev/null 2>&1; do
  sleep 2
done

echo "[minio-init] ensuring bucket '${BUCKET}'"
mc mb --ignore-existing "local/${BUCKET}"

echo "[minio-init] done (CORS is applied server-wide via MINIO_API_CORS_ALLOW_ORIGIN on the minio service, not here)"
