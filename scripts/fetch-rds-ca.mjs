import { mkdir, writeFile } from 'node:fs/promises';

const certificateUrl =
  'https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem';
const certificatePath = '/tmp/rds-global-bundle.pem';
const response = await fetch(certificateUrl);

if (!response.ok) {
  throw new Error(`Unable to download the AWS RDS CA bundle (${response.status}).`);
}

const certificate = await response.text();
if (!certificate.includes('-----BEGIN CERTIFICATE-----')) {
  throw new Error('The AWS RDS CA bundle response was not a PEM certificate bundle.');
}

await mkdir('/tmp', { recursive: true });
await writeFile(certificatePath, certificate, { mode: 0o644 });
