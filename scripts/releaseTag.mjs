#!/usr/bin/env node
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Release tags are semantic versions (vMAJOR.MINOR.PATCH) with an optional
// prerelease suffix. Build metadata is deliberately rejected: it is not part
// of the immutable ECR tag identity, and the commit SHA already lives in the
// OCI revision label.
const semanticReleaseTagPattern =
  /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/**
 * @param {unknown} value
 * @returns {value is string}
 */
export function isSemanticReleaseTag(value) {
  return typeof value === 'string' && semanticReleaseTagPattern.test(value);
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedDirectly) {
  const tag = process.argv[2];
  if (!isSemanticReleaseTag(tag)) {
    process.stderr.write(
      'imageTag must be a semantic release tag such as v2.0.0 or v2.0.0-rc.1; ' +
        'the immutable ECR tag is the release version, not a branch or commit label.\n',
    );
    process.exit(1);
  }
  process.stdout.write(`release tag ${tag} is valid\n`);
}
