# 0004 — CloudFront in front of a private ALB origin

- Status: Accepted
- Date: 2026-10-25

## Context

The application needs HTTPS without owning a custom domain or managing an ACM
certificate and DNS validation. It must not be possible to bypass HTTPS by
calling the ALB directly. Authentication uses cookies, and budget APIs must
not serve shared cached responses.

## Decision

Serve viewers through an AWS-generated CloudFront hostname with the
AWS-managed certificate. CloudFront redirects HTTP to HTTPS, uses the
`CachingDisabled` cache policy, forwards all viewer headers/cookies/query
strings with `AllViewer`, and allows the methods the API needs.

The ALB listener is HTTP only and its security group accepts port 80 only from
the CloudFront origin-facing managed prefix list. CloudFront connects to the
ALB over HTTP. The ALB preserves the viewer `X-Forwarded-For` address so
authentication rate limiting remains per viewer rather than per edge.

## Alternatives considered

- **Public ALB with an ACM certificate** — requires a certificate in the
  application region and a public DNS record; also exposes a second HTTPS
  entry point unless further restricted.
- **Custom domain on CloudFront** — optional, but needs domain ownership, an
  ACM certificate in `us-east-1`, DNS validation, and a deliberate CDK change.
  It is not required for the current deployment.
- **ALB-only HTTP** — rejected because it exposes credentials and sessions in
  transit.

## Consequences

- The public entry point is the CloudFront hostname; the ALB is not publicly
  reachable.
- There is no edge cache to purge during a rollout, but every request reaches
  the origin and CloudFront read timeouts must cover origin latency.
- Replacing the distribution changes the hostname unless a custom domain is
  configured.
- Custom-domain enablement is documented in
  [0011](0011-https-and-custom-domain.md).
