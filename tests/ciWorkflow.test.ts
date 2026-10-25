import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const workflow = readFileSync(
  resolve(projectRoot, '.github/workflows/ci.yml'),
  'utf8',
).replace(/\r\n/g, '\n');

function stepBlock(name: string): string {
  const marker = `      - name: ${name}\n`;
  const start = workflow.indexOf(marker);
  if (start === -1) {
    throw new Error(`The CI workflow does not define the ${name} step.`);
  }

  const next = workflow.indexOf('\n      - name:', start + marker.length);
  return workflow.slice(start, next === -1 ? undefined : next);
}

function indexOfStep(name: string): number {
  return workflow.indexOf(`      - name: ${name}\n`);
}

describe('CI static site coverage', () => {
  it('type-checks the static source tree before building it', () => {
    const check = stepBlock('Check Static Site');

    expect(check).toContain('run: npm run check:static');
    expect(indexOfStep('Check Static Site')).toBeGreaterThan(-1);
    expect(indexOfStep('Check Static Site')).toBeLessThan(
      indexOfStep('Build Static Site'),
    );
  });

  it('builds dist-static and runs the artifact guard against it', () => {
    const build = stepBlock('Build Static Site');
    const guard = stepBlock('Verify Static Build Output');

    expect(build).toContain('run: npm run build:static');
    expect(guard).toContain('run: node scripts/verifyStaticBuild.mjs');
    expect(indexOfStep('Verify Static Build Output')).toBeGreaterThan(
      indexOfStep('Build Static Site'),
    );
  });

  it('keeps the static steps free of deployment and AWS commands', () => {
    for (const name of [
      'Check Static Site',
      'Build Static Site',
      'Verify Static Build Output',
    ]) {
      const step = stepBlock(name);

      expect(step).not.toMatch(/\baws\s/);
      expect(step).not.toContain('s3 ');
      expect(step).not.toContain('cloudfront');
      expect(step).not.toContain('cdk deploy');
      expect(step).not.toContain('secrets.');
    }
  });
});

describe('CI monitoring stack coverage', () => {
  it('synthesizes the monitoring stack explicitly through the supported switch', () => {
    const synth = stepBlock('Synthesize Monitoring Stack');

    expect(synth).toContain('npx cdk synth UniBudgetStack-Monitoring');
    expect(synth).toContain('--no-lookups');
    expect(synth).toContain('-c monitoringOnly=true');
    expect(synth).toContain('-c desiredCount=1');
    expect(synth).toContain('-c alarmTopicArn=arn:aws:sns:');
    expect(synth).toContain('-c loadBalancerFullName=app/');
    expect(synth).toContain('-c targetGroupFullName=targetgroup/');
    expect(synth).toContain('-c clusterName=');
    expect(synth).toContain('-c serviceName=');
    expect(synth).toContain('working-directory: hello-cdk');
  });

  it('keeps the application-stack synthesis separate', () => {
    const appSynth = stepBlock('Synthesize CDK');
    const monitoringSynth = stepBlock('Synthesize Monitoring Stack');

    expect(appSynth).toContain('npx cdk synth --no-lookups');
    expect(appSynth).not.toContain('monitoringOnly');
    expect(monitoringSynth).not.toContain('UniBudgetStack ');

    expect(indexOfStep('Synthesize CDK')).toBeGreaterThan(-1);
    expect(indexOfStep('Synthesize Monitoring Stack')).toBeGreaterThan(
      indexOfStep('Synthesize CDK'),
    );
  });
});

describe('CI keeps the existing gates', () => {
  it('still runs the server-rendered checks, tests and build', () => {
    expect(stepBlock('Check Astro')).toContain('run: npm run check');
    expect(stepBlock('Run ESLint')).toContain('run: npm run lint');
    expect(stepBlock('Run Tests')).toContain('npm test -- --run');
    expect(stepBlock('Build Astro Site')).toContain('run: npm run build');
    expect(stepBlock('Build Docker Image')).toContain(
      'docker build -f dockerfile -t unibudget:ssr .',
    );
  });

  it('still builds, tests and synthesizes the CDK application stack', () => {
    expect(stepBlock('Build CDK')).toContain('run: npm run build');
    expect(stepBlock('Test CDK')).toContain('npm test -- --runInBand');

    const appSynth = stepBlock('Synthesize CDK');
    expect(appSynth).toContain('-c imageTag=ci-synth');
    expect(appSynth).toContain(
      '-c supabaseHost=aws-0-eu-central-1.pooler.supabase.com',
    );
    expect(appSynth).toContain(
      '-c cloudFrontOriginPrefixListId=pl-0123456789abcdef0',
    );
  });
});

describe('CI does not perform deployment operations', () => {
  it('contains no AWS, deployment, invalidation or secret-printing commands', () => {
    expect(workflow).not.toMatch(/\baws\s/);
    expect(workflow).not.toContain('cdk deploy');
    expect(workflow).not.toContain('cdk bootstrap');
    expect(workflow).not.toContain('cdk destroy');
    expect(workflow).not.toContain('s3 cp');
    expect(workflow).not.toContain('create-invalidation');
    expect(workflow).not.toContain('npm run migrate');
    expect(workflow).not.toContain('secrets.');
    expect(workflow).not.toContain('printenv');
  });

  it('keeps the migration runtime check read-only against the built image', () => {
    const step = stepBlock('Verify Migration Runtime Modules');

    expect(step).toContain('docker run --rm --entrypoint node unibudget:ssr');
    expect(step).not.toContain('APP_DATABASE_PASSWORD:');
    expect(step).not.toMatch(/\baws\s/);
  });
});
