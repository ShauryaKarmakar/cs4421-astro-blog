# 0008 — Immutable ECR images, semantic releases, and provenance

- Status: Accepted
- Date: 2026-10-25

## Context

A deployment must be identifiable after the fact. Mutable tags such as `latest`
cannot prove which code is running, and a tag alone does not provide a
content-addressed identity. The ECR repository also has a finite retention
window, so a second tag per release would consume rollback capacity.

## Decision

- ECR tag mutability is **IMMUTABLE**. A release tag cannot be repointed.
- A release uses an annotated Git tag and the same `vMAJOR.MINOR.PATCH` string
  as the ECR tag; a prerequisite/workflow check rejects non-semver image tags.
- The image digest (`sha256:...`) is the content identity and is recorded by
  the deployment workflow. The workflow verifies the running ECS task's
  `imageDigest`, not only its tag.
- The Dockerfile records `org.opencontainers.image.version` and
  `org.opencontainers.image.revision`; the workflow supplies the release tag
  and `GITHUB_SHA`.
- No second commit-SHA ECR tag is created. The git tag and OCI revision label
  carry the source mapping without halving the tagged retention window.
- ECR retains the ten newest tagged releases and ten newest untagged
  manifests. A pre-push workflow gate rejects a live `tagStatus: any`/small
  policy because one push creates an index, a platform manifest, and an
  attestation.

## Alternatives considered

- **Mutable `latest` plus SHA tags** — rejected because `latest` is not a
  release identity and every extra tag consumes retention.
- **Digest-only deployment with no human tag** — robust, but the task
  definition and release procedure need a readable version; the tag and digest
  are both recorded.
- **Release tags derived from the commit SHA** — rejected because it obscures
  the release version and duplicates provenance already in the label.

## Consequences

- A tag collision fails the build before the push; a new release requires a new
  semantic version.
- The historical `v1` image and `v1.0.0` Git tag are not reconciled. Do not
  move the published tag; reconcile forward with the next release.
- The image must be rebuilt and retagged for every release; images are not
  promoted by relabeling.
- The OCI labels are only present on images built after the provenance change;
  older images cannot be retroactively proven.
