# 0011 — HTTPS on the CloudFront hostname; custom domain optional

- Status: Accepted
- Date: 2026-10-25

## Context

UniBudget must serve credentials and session cookies over HTTPS. The project
does not currently own or control a domain name, and an unverified certificate
or invented DNS record would not be a real deployment improvement.

## Decision

Use the AWS-generated `*.cloudfront.net` hostname with CloudFront's managed
certificate. CloudFront redirects viewer HTTP to HTTPS. The ALB origin is HTTP
inside the private origin path, and its security group accepts port 80 only
from the CloudFront origin-facing prefix list.

A custom domain is optional and disabled by default. Enabling it would require
all of the following, none of which is present today:

1. ownership and DNS control of the domain;
2. an ACM certificate in `us-east-1` covering the chosen hostname;
3. DNS validation of that certificate;
4. a CDK change adding `domainNames` and `certificate` to the distribution;
5. DNS routing to the distribution and post-change verification.

## Alternatives considered

- **Public ALB with an ACM certificate** — adds a second public HTTPS entry
  point and requires a public certificate/DNS dependency.
- **HTTP-only ALB** — rejected; credentials and sessions would traverse the
  network unencrypted.
- **A custom domain now** — blocked by missing domain ownership; inventing one
  would create a false claim.

## Consequences

- HTTPS is complete for the default CloudFront hostname; no certificate,
  DNS, or custom-domain work is required for the current release.
- Replacing the CloudFront distribution changes the public hostname.
- The ALB cannot be reached directly from the internet; verification must use
  the CloudFront URL.
- Custom-domain work is a future, explicitly approved infrastructure change,
  not a hidden prerequisite for this deployment.
