# MinIO and mc compiled from their official source tags -- dev server only
# (amoa/questions/DEVSERVER-2026-11-05.md §6).
#
# MinIO stopped distributing ready-made artefacts: quay.io/minio/minio answers 401, minio/minio no
# longer exists on Docker Hub, and dl.min.io answers 410 Gone for both server and client binaries
# (checked 2026-11-05). Only the source remains on GitHub. The tags below are the versions running
# in the local development image, so the dev server matches what the test suite runs against.
#
#   docker compose -f infra/devserver/compose.yaml --env-file /etc/babana/babana.env build minio
ARG GO_IMAGE=golang:1.24-alpine

FROM ${GO_IMAGE} AS build
ARG MINIO_RELEASE=RELEASE.2025-09-07T16-13-09Z
ARG MC_RELEASE=RELEASE.2025-08-13T08-35-41Z
RUN apk add --no-cache git
ENV CGO_ENABLED=0 GOTOOLCHAIN=auto
# gen-ldflags.go reads the version from `git log`: a shallow clone of the tag is enough.
RUN git clone --quiet --depth 1 --branch "${MINIO_RELEASE}" https://github.com/minio/minio.git /src/minio
WORKDIR /src/minio
RUN go build -tags kqueue -trimpath -ldflags "$(go run buildscripts/gen-ldflags.go)" -o /out/minio
RUN git clone --quiet --depth 1 --branch "${MC_RELEASE}" https://github.com/minio/mc.git /src/mc
WORKDIR /src/mc
RUN go build -tags kqueue -trimpath -ldflags "$(go run buildscripts/gen-ldflags.go)" -o /out/mc

FROM alpine:3.20
RUN apk add --no-cache ca-certificates && adduser -D -H -u 1000 minio && mkdir -p /data && chown minio /data
COPY --from=build /out/minio /out/mc /usr/bin/
# `mc` keeps its aliases in a config directory; the minio user has no home.
ENV MC_CONFIG_DIR=/tmp/.mc
USER minio
EXPOSE 9000 9001
ENTRYPOINT ["minio"]
CMD ["server", "/data", "--console-address", ":9001"]
