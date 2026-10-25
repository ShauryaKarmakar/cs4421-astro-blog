#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const REQUIRED_TAGGED_RETENTION = 10;
export const REQUIRED_UNTAGGED_RETENTION = 10;

/**
 * Assess an ECR lifecycle policy before a release pushes a new image.
 *
 * The repository must retain at least ten tagged releases and ten untagged
 * manifests. A `tagStatus: any` rule is rejected because one docker push
 * produces a tagged OCI index plus platform/attestation manifests, so an
 * `any` count expires rollback images far faster than a tag-based count.
 *
 * @param {string} text
 * @returns {{ safe: boolean, issues: string[] }}
 */
export function assessLifecyclePolicy(text) {
  /** @type {string[]} */
  const issues = [];
  let policy;
  try {
    policy = JSON.parse(text);
  } catch {
    return { safe: false, issues: ['lifecycle policy is not valid JSON'] };
  }

  const rules = Array.isArray(policy?.rules) ? policy.rules : [];
  if (rules.length === 0) {
    return { safe: false, issues: ['lifecycle policy has no rules'] };
  }
  if (rules.some((rule) => rule?.selection?.tagStatus === 'any')) {
    issues.push('a tagStatus "any" rule would count tagged, platform, and attestation manifests together');
  }
  if (rules.length !== 2) {
    issues.push(`expected exactly two rules (tagged and untagged), found ${rules.length}`);
  }

  /**
   * @param {'tagged' | 'untagged'} tagStatus
   * @param {number} requiredCount
   */
  const checkRule = (tagStatus, requiredCount) => {
    const matching = rules.filter(
      (rule) => rule?.selection?.tagStatus === tagStatus,
    );
    if (matching.length !== 1) {
      issues.push(`expected exactly one ${tagStatus} rule, found ${matching.length}`);
      return;
    }
    const [rule] = matching;
    const count = Number(rule?.selection?.countNumber);
    if (rule?.selection?.countType !== 'imageCountMoreThan') {
      issues.push(`${tagStatus} rule must use imageCountMoreThan`);
    }
    if (!Number.isInteger(count) || count < requiredCount) {
      issues.push(`${tagStatus} rule must retain at least ${requiredCount} images, found ${rule?.selection?.countNumber}`);
    }
    if (rule?.action?.type !== 'expire') {
      issues.push(`${tagStatus} rule must use the expire action`);
    }
    if (tagStatus === 'tagged') {
      const patterns = rule?.selection?.tagPatternList;
      if (!Array.isArray(patterns) || !patterns.includes('*')) {
        issues.push('tagged rule must match all release tags with "*"');
      }
    }
  };

  checkRule('tagged', REQUIRED_TAGGED_RETENTION);
  checkRule('untagged', REQUIRED_UNTAGGED_RETENTION);

  return { safe: issues.length === 0, issues };
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedDirectly) {
  const source = process.argv[2] === '-' || process.argv[2] === undefined
    ? readFileSync(0, 'utf8')
    : readFileSync(process.argv[2], 'utf8');
  const result = assessLifecyclePolicy(source);
  if (!result.safe) {
    process.stderr.write(
      `ECR lifecycle policy is not release-safe:\n- ${result.issues.join('\n- ')}\n` +
        'Apply the CDK-managed retention policy before pushing a release image.\n',
    );
    process.exit(1);
  }
  process.stdout.write('ECR lifecycle policy is release-safe\n');
}
