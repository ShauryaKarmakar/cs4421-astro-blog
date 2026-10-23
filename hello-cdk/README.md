# UniBudget CDK stack

This stack defines the ECS Fargate application, ALB, ECR repository, migration
task, and the retained RDS resources. The application image is built from the
repository root Dockerfile and pushed to ECR; the stack does not deploy a local
`dist` directory.

Run CDK commands from this `hello-cdk` directory. The stack requires an explicit
image tag and Supabase session-pooler hostname, and a certificate requires the
custom HTTPS application URL:

```bash
npx cdk synth --no-lookups \
  -c imageTag=<immutable-tag> \
  -c supabaseHost=<project-pooler-host>

npx cdk deploy --require-approval never \
  -c imageTag=<immutable-tag> \
  -c desiredCount=0 \
  -c certificateArn=<acm-certificate-arn> \
  -c applicationUrl=https://<custom-domain> \
  -c supabaseHost=<project-pooler-host>
```

`desiredCount=0` is the bootstrap deploy: it creates the ECR repository and task
definitions without starting the application. Follow the full sequence in
[../docs/deployment.md](../docs/deployment.md).

## Useful commands

- `npm run build` - type-check the project
- `npm run watch` - watch for changes and type-check
- `npm run test` - run the Jest unit tests
- `npx cdk diff` - compare the deployed stack with the current state (pass the same `-c` values)
- `npx cdk synth` - emit the synthesized CloudFormation template (pass the same `-c` values)
