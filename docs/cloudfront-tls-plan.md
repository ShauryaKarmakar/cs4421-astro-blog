# CloudFront minimum TLS — migration requirements (not applied)

Status: **planning only. No distribution, DNS record, certificate, workflow, or
stack was changed.** Reviewed 2026-10-27.

## 1. Verified current state

Read-only `aws cloudfront`, `aws acm`, and `aws route53` calls, account
`556890483680`, `us-east-1`:

| Item | SSR distribution | Static blog distribution |
| --- | --- | --- |
| Distribution ID | `E30KFH719MS9Z0` | `E2JVO3G1WG2Q2T` |
| Public hostname | `d3jsso3b2vz1cp.cloudfront.net` | `d2eip6kpluaijf.cloudfront.net` |
| Status / enabled | `Deployed` / true | `Deployed` / true |
| Alternate domain names | none (`Aliases.Quantity = 0`) | none |
| Certificate | CloudFront default (`CloudFrontDefaultCertificate: true`) | CloudFront default |
| SSL support method | `vip` | `vip` |
| Minimum viewer protocol | **`TLSv1`** | **`TLSv1`** |
| Viewer protocol policy | `redirect-to-https` | `redirect-to-https` |
| Origin | ALB `UniBud-Appli-p0ktuGjGHELm-…elb.amazonaws.com` | S3 `staticsitestack-sitebucket…` |

There are **no ACM certificates in `us-east-1`** and **no Route 53 hosted
zones** in the account. The project therefore has no domain or certificate to
attach today.

## 2. Why it cannot be fixed with a setting

CloudFront's default `*.cloudfront.net` certificate only supports the `TLSv1`
viewer policy. `TLSv1.2_2021` requires an alternate domain name and a custom
certificate with SNI. Changing `MinimumProtocolVersion` alone is rejected or
has no effect. This is an AWS platform constraint, not a missing CDK property.

The application stack currently relies on this deliberately
(`docs/adr/0011-https-and-custom-domain.md`), and the deploy workflow enforces
it: it rejects any ACM certificate and any alias on the SSR distribution
(`.github/workflows/deploy.yml`, "Verify CloudFront configuration"). A TLS
change is therefore a coordinated code + workflow + DNS change, not a one-line
edit. AWS documents the viewer policy/certificate relationship in
[Supported protocols and ciphers between viewers and CloudFront](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/secure-connections-supported-viewer-protocols-ciphers.html)
and [Distribution settings](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/DownloadDistValuesGeneral.html).

## 3. Migration requirements

### 3.1 Domain and DNS

1. A hostname controlled by the operator, for example `app.example.com` for the
   SSR site and `blog.example.com` for the static site, or one hostname with
   path-based routing if a single distribution is preferred (not proposed here).
2. DNS control at the registrar or provider. A Route 53 hosted zone is optional;
   an external provider can hold the CNAME/Alias records.
3. Approval from whoever controls DNS; this plan does not assume that access.

### 3.2 Certificate

1. Request an ACM certificate in **`us-east-1`** (CloudFront only accepts
   certificates from that region). It must cover every alternate hostname.
2. Validate it by DNS (preferred) before any distribution change. Email
   validation is possible but slower and more fragile.
3. Record the certificate ARN. Do not hardcode it in source; pass it as CDK
   context or a repository variable, the same way `imageTag` and
   `deploymentAlarmName` are passed.
4. Confirm the certificate is `ISSUED`, not `PENDING_VALIDATION`, before the
   first deployment that references it.

### 3.3 Application distribution (this repository)

`hello-cdk/lib/cdk-stack.ts` owns `ApplicationDistribution`. The change is:

```ts
import * as acm from 'aws-cdk-lib/aws-acm';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';

// Illustrative inputs only: replace both placeholders and pass the real values
// through CDK context or a repository variable, never from source.
const certificateArn =
  'arn:aws:acm:us-east-1:000000000000:certificate/00000000-0000-0000-0000-000000000000';
const applicationHostname = 'app.example.com';

const viewerCertificate = acm.Certificate.fromCertificateArn(
  this,
  'ViewerCertificate',
  certificateArn,
);

const distribution = new cloudfront.Distribution(this, 'ApplicationDistribution', {
  // ...existing comment, enabled, httpVersion, defaultBehavior...
  domainNames: [applicationHostname],
  certificate: viewerCertificate,
  sslSupportMethod: cloudfront.SSLMethod.SNI,
  minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
});
```

Required consequences in the same change:

| Area | Required change |
| --- | --- |
| `ApplicationUrl` output | Must become `https://<custom hostname>`, not the distribution domain |
| `CloudFrontDomainName` output | Keep it; it is still useful for diagnostics |
| Stack inputs | `certificateArn` and `applicationHostname` become validated context values; fail synthesis when one is present without the other |
| Distribution comment | Stop saying "AWS-generated CloudFront hostname" |
| CDK test `serves HTTPS from the AWS-generated CloudFront hostname without a custom domain` | Replace with assertions for `Aliases`, `ViewerCertificate.ACMCertificateArn`, `SSLSupportMethod: sni-only`, `MinimumProtocolVersion: TLSv1.2_2021`, and no certificate resource created by the stack (the certificate is imported) |

### 3.4 Deploy workflow and tests

`.github/workflows/deploy.yml` currently fails closed on a custom domain:

- `CloudFrontDomainName` must match `^[a-z0-9]+\.cloudfront\.net$`.
- `ApplicationUrl` must equal `https://$cloudfront_domain`.
- `require_config "custom domain count" … "0"`.
- Any `ACMCertificateArn` is an error.

These checks exist to prevent drift, so they must be replaced, not deleted:

- Accept the expected custom hostname from a repository variable (for example
  `APPLICATION_HOSTNAME`) and require `Aliases.Items` to equal it.
- Require `ViewerCertificate.ACMCertificateArn` to equal the expected
  certificate ARN, `SSLSupportMethod` to be `sni-only`, and
  `MinimumProtocolVersion` to be `TLSv1.2_2021`.
- Keep the origin, cache policy, methods, and redirect checks unchanged.
- Keep a check that `ApplicationUrl` is HTTPS and resolves to the custom
  hostname.

`tests/deployWorkflow.test.ts` asserts the current CloudFront gate strings; it
must be updated in the same change. `tests/staticDeployment.test.ts` and
`scripts/verifyStaticSite.mjs` hard-code the static host and must change only
if the static distribution moves to a custom domain.

### 3.5 Static distribution (source not in this repository)

`StaticSiteStack` (`E2JVO3G1WG2Q2T`, bucket
`staticsitestack-sitebucket397a1860-33rkrycbsdvl`) is deployed from a stack
whose CDK source is **not in this repository**. Its TLS cannot be changed by
this repo alone. Requirements if it is included:

- Locate and review the stack source; add `domainNames`, an imported `us-east-1`
  ACM certificate, `SNI`, and `TLSv1.2_2021` there.
- Update `.github/workflows/deploy-static.yml` (`STATIC_SITE_HOST`,
  `STATIC_SITE_URL`, the hard-coded `STATIC_DISTRIBUTION_ID`/SSR guard) and
  `astro.config.static.mjs`, `scripts/verifyStaticBuild.mjs`,
  `scripts/verifyStaticSite.mjs`.
- Decide whether both hostnames share one certificate (SAN) or use separate
  certificates. Either is valid; one certificate simplifies renewal.

### 3.6 Behavioural changes

- Viewers must negotiate TLS 1.2 or 1.3. TLS 1.0/1.1 clients fail.
- SNI is required; clients without SNI fail.
- The session cookie is host-only, so moving from `*.cloudfront.net` to the
  custom hostname signs every user out once.
- Absolute URLs in content, sitemap, or email would need review. Astro redirects
  and links in this app are relative, so the path behaviour is expected to stay
  the same.
- The old `*.cloudfront.net` hostname continues to serve unless it is disabled
  or restricted; document which hostname is the supported entry point. Do not
  disable it until DNS and monitoring point at the new hostname.
- Cost does not change materially; ACM certificates for CloudFront are free.

## 4. Staged migration sequence

1. **Prepare (no production change):** choose hostnames; request and DNS-validate
   the ACM certificate; add the CDK context values and unit tests; update the
   workflow gate and its contract tests; run the full local suite, `cdk synth`,
   and `cdk diff` against a staging account.
2. **Staging:** deploy the distribution change in a staging account with a
   staging hostname. Verify a TLS 1.2 handshake, a rejected TLS 1.1 handshake,
   HTTP→HTTPS redirect, `/`, `/login`, `/api/health`, a real blog slug, and the
   unknown-slug 404.
3. **Production distribution change:** deploy in a low-traffic window. At this
   point the custom hostname works, but DNS still points to the old hostname.
4. **DNS cutover:** lower the TTL in advance, then switch the record to the
   distribution. Verify the same routes through the custom hostname.
5. **Observation:** watch 4xx/5xx and the `Request5xx` alarm for at least one
   business day. Do not disable the old hostname until the new one is stable.
6. **Cleanup (separate approval):** decide whether to leave the
   `*.cloudfront.net` hostname reachable for compatibility.

## 5. Verification and acceptance

- `aws cloudfront get-distribution-config` shows the expected
  `Aliases.Items`, `ACMCertificateArn`, `SSLSupportMethod: sni-only`, and
  `MinimumProtocolVersion: TLSv1.2_2021`.
- `openssl s_client -connect <host>:443 -servername <host> -tls1_1` fails;
  `-tls1_2` and the default handshake succeed with the expected certificate.
- `curl -I http://<host>/` returns a redirect to HTTPS.
- The post-deploy route checks in the Deploy workflow pass on the custom
  hostname, including the `X-Request-Id` check.
- The `cloudfront-tls` assertions in the workflow and tests are updated and
  green; no test still expects zero aliases or no certificate.
- Both distributions report `Deployed` and the custom hostnames resolve.

## 6. Rollback

- Revert the CDK change and redeploy, or restore the previous distribution
  configuration with `update-distribution` using the saved ETag.
- Restore the old DNS record only after the distribution change is reverted;
  keep the certificate and DNS zone during rollback.
- **Rolling back returns viewers to `TLSv1`.** Record why, and re-open this plan.
- Do not delete the distribution or the old hostname while DNS is in flight.

## 7. Blockers and risks

- **No domain, no ACM certificate, no hosted zone today.** Nothing can be
  raised until a domain is available.
- **The deploy workflow currently rejects aliases and ACM certificates by
  design.** The gate and its tests must change together, or every deployment
  after the distribution change fails closed.
- **The static stack source is outside this repository.** Its TLS is a separate
  deliverable.
- **DNS/certificate mistakes can take the site offline.** Validate the
  certificate and prepare DNS before switching; use a low TTL.
- **Custom-domain governance.** Whoever controls DNS must approve and perform
  the change.

## 8. Decision requested

1. **Blocked:** no domain is available. Keep `TLSv1` as a documented
   limitation; do not claim TLS 1.2 enforcement.
2. **Proceed once a domain exists:** prepare the certificate and the CDK/workflow
   change in staging, then follow §4.

Neither option is applied by this document.
