# CloudFront minimum TLS — proposed change (not applied)

Status: **Proposal only.** No CloudFront distribution, DNS record, or
certificate was changed. This is deliberately separate from the monitoring
deployment.

## Verified current state (2026-10-25)

| Item | Observed value |
| --- | --- |
| Distribution | `E30KFH719MS9Z0`, enabled, status `Deployed` |
| Public hostname | `d3jsso3b2vz1cp.cloudfront.net` |
| Alternate domain names | none (`Aliases.Quantity = 0`) |
| Certificate | CloudFront default certificate (`CloudFrontDefaultCertificate: true`, `CertificateSource: cloudfront`) |
| SSL support method | `vip` |
| Minimum protocol version | **`TLSv1`** |
| Viewer protocol policy | `redirect-to-https` |
| HTTP version | `http2and3` |

## Finding

CloudFront's default `*.cloudfront.net` certificate does not allow a modern
viewer security policy. AWS documents that the default certificate uses
`TLSv1`; selecting `TLSv1.2_2021` requires a custom certificate, an alternate
domain name, and SNI. This is a platform constraint, not a CDK setting that was
missed. See the AWS
[viewer protocol and cipher documentation](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/secure-connections-supported-viewer-protocols-ciphers.html)
and [distribution settings](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/DownloadDistValuesGeneral.html).

Changing `MinimumProtocolVersion` alone would be rejected or ineffective. The
distribution has no alternate domain name and no ACM certificate, so there is
no supported way to raise the minimum viewer protocol on the current
`*.cloudfront.net` hostname.

## Recommendation

If a controlled domain is available, move the distribution to a custom domain
and use **`TLSv1.2_2021`** as the minimum viewer security policy. That policy
supports TLS 1.2 and TLS 1.3 and is the modern supported choice for this
distribution. Do not choose `TLSv1.2_2018` or `TLSv1.2_2019`; they are older
policy variants with weaker cipher suites.

If no domain is available, keep the current hostname and record `TLSv1` as an
accepted platform limitation. Do not claim that the site enforces TLS 1.2.

## Proposed change, after separate approval

Prerequisites:

1. A domain name controlled by the operator, for example
   `app.example.com`.
2. An ACM certificate in **`us-east-1`** (CloudFront only uses certificates
   from that region), validated by DNS or email.
3. A DNS record at the domain's DNS provider pointing the chosen hostname at
   the CloudFront distribution.
4. A decision that changing the public hostname is acceptable. The session
   cookie is host-only, so sessions do not carry over from the old
   `*.cloudfront.net` hostname; users sign in again on the new hostname.

The corresponding `hello-cdk/lib/cdk-stack.ts` change would be of this shape
(imports and certificate wiring are illustrative; do not apply without the
domain and certificate):

```ts
import * as acm from 'aws-cdk-lib/aws-acm';

const viewerCertificate = acm.Certificate.fromCertificateArn(
  this,
  'ViewerCertificate',
  certificateArn,
);

const distribution = new cloudfront.Distribution(this, 'ApplicationDistribution', {
  // ...existing comment, enabled, httpVersion, defaultBehavior...
  domainNames: ['app.example.com'],
  certificate: viewerCertificate,
  sslSupportMethod: cloudfront.SSLMethod.SNI,
  minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
});
```

The distribution's `ApplicationUrl` output and the deployment workflow's
public URL checks must use the custom hostname after the change. The ALB,
origin protocol, cache policy, and origin-facing prefix-list restriction do not
change.

## Expected effects

- Viewers must negotiate TLS 1.2 or TLS 1.3. TLS 1.0/1.1 clients fail.
- SNI-only certificate selection is used; very old clients without SNI fail.
- The public origin becomes the custom hostname; `*.cloudfront.net` remains
  available as a distribution hostname unless disabled, but it is no longer the
  documented entry point.
- Existing absolute URLs, if any, must be reviewed. Astro redirects are
  relative, so the application path is expected to keep working.
- CloudFront and ALB costs do not materially change. ACM certificates for
  CloudFront are free.

## Rollback considerations

- Revert the CDK change and redeploy, or restore the previous distribution
  configuration with `update-distribution` using the saved ETag.
- Keep the ACM certificate and DNS record during rollback; removing them first
  makes recovery slower.
- If the custom hostname fails validation, do not delete the existing
  distribution. Restore the prior `Aliases` and `ViewerCertificate` settings
  and investigate DNS/ACM separately.
- A rollback returns viewers to `TLSv1`, so it is a security regression. Record
  why it was necessary.

## Risks and dependencies

- **Blocked by the application stack's ECR drift.** The distribution is owned by
  `UniBudgetStack`. A normal stack update currently also proposes ECR, ECS
  service, task-definition, and IAM changes. This TLS change must not be bundled
  into that update without reviewing those effects.
- **DNS/certificate failure can take the site offline.** Validate the
  certificate and create the DNS record before switching the distribution.
- **Custom-domain governance.** Whoever controls DNS must approve and perform
  the record change; this plan does not request or assume that access.
- **No wildcard assumption.** Use an exact hostname certificate unless a
  wildcard is explicitly approved.
- **Evidence required after any future change:** `get-distribution-config` must
  show the ACM certificate ARN, the alternate domain, `sni-only`, and
  `TLSv1.2_2021`; an HTTPS request must complete with a TLS 1.2+ handshake.

## Decision requested

Choose one:

1. **Prepare the custom-domain/ACM change** once a domain is available and the
   application stack's ECR/ECS churn is resolved.
2. **Accept `TLSv1` temporarily** and keep this as a documented security
   limitation.

Neither option is applied by this document.
