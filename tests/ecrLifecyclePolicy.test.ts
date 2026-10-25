import { describe, expect, it } from 'vitest';
import {
  assessLifecyclePolicy,
  REQUIRED_TAGGED_RETENTION,
  REQUIRED_UNTAGGED_RETENTION,
} from '../scripts/ecrLifecyclePolicy.mjs';

function safePolicy() {
  return {
    rules: [
      {
        rulePriority: 1,
        description: 'Retain tagged releases',
        selection: {
          tagStatus: 'tagged',
          tagPatternList: ['*'],
          countType: 'imageCountMoreThan',
          countNumber: REQUIRED_TAGGED_RETENTION,
        },
        action: { type: 'expire' },
      },
      {
        rulePriority: 2,
        description: 'Retain untagged manifests',
        selection: {
          tagStatus: 'untagged',
          countType: 'imageCountMoreThan',
          countNumber: REQUIRED_UNTAGGED_RETENTION,
        },
        action: { type: 'expire' },
      },
    ],
  };
}

describe('ECR lifecycle policy safety', () => {
  it('accepts the ten-tagged / ten-untagged policy used by CDK', () => {
    expect(assessLifecyclePolicy(JSON.stringify(safePolicy()))).toEqual({
      safe: true,
      issues: [],
    });
  });

  it('rejects the live tagStatus:any / keep-five policy', () => {
    const result = assessLifecyclePolicy(
      JSON.stringify({
        rules: [
          {
            rulePriority: 1,
            selection: {
              tagStatus: 'any',
              countType: 'imageCountMoreThan',
              countNumber: 5,
            },
            action: { type: 'expire' },
          },
        ],
      }),
    );

    expect(result.safe).toBe(false);
    expect(result.issues.join('\n')).toMatch(/tagStatus "any"/);
    expect(result.issues.join('\n')).toMatch(/expected exactly two rules/);
  });

  it('rejects a tagged rule below the rollback retention floor', () => {
    const policy = safePolicy();
    policy.rules[0].selection.countNumber = 5;

    const result = assessLifecyclePolicy(JSON.stringify(policy));

    expect(result.safe).toBe(false);
    expect(result.issues.join('\n')).toMatch(/tagged rule must retain at least 10/);
  });

  it('rejects untagged retention below the floor', () => {
    const policy = safePolicy();
    policy.rules[1].selection.countNumber = 1;

    const result = assessLifecyclePolicy(JSON.stringify(policy));

    expect(result.safe).toBe(false);
    expect(result.issues.join('\n')).toMatch(/untagged rule must retain at least 10/);
  });

  it('rejects a tagged rule that does not cover every release tag', () => {
    const policy = safePolicy();
    policy.rules[0].selection.tagPatternList = ['v1.*'];

    const result = assessLifecyclePolicy(JSON.stringify(policy));

    expect(result.safe).toBe(false);
    expect(result.issues.join('\n')).toMatch(/must match all release tags/);
  });

  it('rejects sinceImagePushed rules that could expire a rollback image by age', () => {
    const policy = safePolicy();
    policy.rules[0].selection.countType = 'sinceImagePushed';

    const result = assessLifecyclePolicy(JSON.stringify(policy));

    expect(result.safe).toBe(false);
    expect(result.issues.join('\n')).toMatch(/imageCountMoreThan/);
  });

  it('rejects a missing or extra rule because it is not auditable', () => {
    const missing = safePolicy();
    missing.rules.pop();
    expect(assessLifecyclePolicy(JSON.stringify(missing)).safe).toBe(false);

    const extra = safePolicy();
    extra.rules.push({
      rulePriority: 3,
      selection: {
        tagStatus: 'tagged',
        tagPatternList: ['*'],
        countType: 'imageCountMoreThan',
        countNumber: 1,
      },
      action: { type: 'expire' },
    });
    expect(assessLifecyclePolicy(JSON.stringify(extra)).safe).toBe(false);
  });

  it('rejects malformed policy text', () => {
    expect(assessLifecyclePolicy('not-json').safe).toBe(false);
    expect(assessLifecyclePolicy('{}').safe).toBe(false);
    expect(assessLifecyclePolicy('{"rules":[]}').safe).toBe(false);
  });
});
