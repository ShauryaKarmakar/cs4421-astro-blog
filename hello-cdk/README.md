# UniBudget CDK stack

This stack defines the ECS Fargate application, ALB, CloudFront distribution,
ECR repository, migration task, and the retained RDS resources. The application
image is built from the repository root Dockerfile and pushed to ECR; the stack
does not deploy a local `dist` directory.

CloudFront serves HTTPS on its AWS-generated `*.cloudfront.net` hostname with
the AWS-managed certificate, so no custom domain or ACM certificate is needed.
The ALB is an HTTP origin that accepts traffic only from the CloudFront
origin-facing prefix list.

Run CDK commands from this `hello-cdk` directory. A release uses a semantic
image tag (`vMAJOR.MINOR.PATCH`); the stack itself accepts any valid immutable
tag because it also supports bootstrap and maintenance deploys. The stack
requires a Supabase session-pooler hostname and the regional CloudFront
origin-facing prefix list ID:

```bash
prefix_list_id=$(aws ec2 describe-managed-prefix-lists \
  --filters Name=prefix-list-name,Values=com.amazonaws.global.cloudfront.origin-facing \
  --query 'PrefixLists[0].PrefixListId' --output text)

npx cdk synth --no-lookups \
  -c imageTag=v1.1.0 \
  -c supabaseHost=<project-pooler-host> \
  -c cloudFrontOriginPrefixListId="$prefix_list_id" \
  -c alarmTopicArn=<optional-existing-sns-topic-arn>

npx cdk deploy --require-approval never \
  -c imageTag=v1.1.0 \
  -c desiredCount=0 \
  -c supabaseHost=<project-pooler-host> \
  -c cloudFrontOriginPrefixListId="$prefix_list_id" \
  -c alarmTopicArn=<optional-existing-sns-topic-arn>
```

`desiredCount=0` is the bootstrap deploy: it creates the ECR repository, task
definitions, load balancer, and CloudFront distribution without starting the
application. `alarmTopicArn` is optional; when omitted, alarms exist but have
no notification action. The stack imports an existing topic and never creates
or subscribes one.

The stack declares ten-tagged/ten-untagged ECR retention. That policy is not
the live policy until the stack is deployed, and the deployment workflow
refuses to push an image while the live policy is the older `tagStatus: any`
rule. Apply the policy before the next release. Follow the full sequence in
[../docs/deployment.md](../docs/deployment.md) and the release gate in
[../docs/release-readiness.md](../docs/release-readiness.md).

## Useful commands

- `npm run build` - type-check the project
- `npm run watch` - watch for changes and type-check
- `npm run test` - run the Jest unit tests
- `npx cdk diff` - compare the deployed stack with the current state (pass the same `-c` values)
- `npx cdk synth` - emit the synthesized CloudFormation template (pass the same `-c` values)
