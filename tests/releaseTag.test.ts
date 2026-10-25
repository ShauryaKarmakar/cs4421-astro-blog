import { describe, expect, it } from 'vitest';
import { isSemanticReleaseTag } from '../scripts/releaseTag.mjs';

describe('release tag validation', () => {
  it('accepts semantic release versions with an optional prerelease', () => {
    for (const tag of [
      'v0.1.0',
      'v1.0.0',
      'v2.0.0',
      'v2.3.4',
      'v2.0.0-rc.1',
      'v2.0.0-hotfix.2',
      'v2.0.0-rc.1.beta-2',
    ]) {
      expect(isSemanticReleaseTag(tag), tag).toBe(true);
    }
  });

  it('rejects mutable, abbreviated, and malformed tags', () => {
    for (const tag of [
      '',
      'latest',
      'v1',
      '1.0.0',
      'v1.0',
      'v01.0.0',
      'v1.00.0',
      'v1.0.00',
      'v1.0.0+build.5',
      'v1.0.0-',
      'v1.0.0-rc..1',
      'release-v1.0.0',
      'v1.0.0 ',
    ]) {
      expect(isSemanticReleaseTag(tag), tag).toBe(false);
    }
  });

  it('rejects non-string input', () => {
    expect(isSemanticReleaseTag(undefined)).toBe(false);
    expect(isSemanticReleaseTag(null)).toBe(false);
    expect(isSemanticReleaseTag(100)).toBe(false);
  });
});
