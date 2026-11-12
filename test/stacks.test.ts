import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { FoundationStack } from "../lib/foundation-stack.js";
import { MappingStack } from "../lib/mapping-stack.js";

const ACCOUNT = "111122223333";

describe("FoundationStack", () => {
  it("creates an explicit diagnostics role with one-hour sessions", () => {
    const app = new App();
    const stack = new FoundationStack(app, "Foundation", {
      stage: "test",
      env: { account: ACCOUNT, region: "us-east-1" },
    });
    const template = Template.fromStack(stack);
    template.hasResourceProperties("AWS::IAM::Role", {
      MaxSessionDuration: 3600,
      RoleName: "self-healing-agent-test-claude-readonly",
      ManagedPolicyArns: Match.absent(),
    });
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: { Statement: Match.arrayWith([Match.objectLike({
        Action: Match.arrayWith(["cloudwatch:DescribeAlarms", "cloudwatch:GetMetricData"]), Resource: "*",
      })]) },
    });
    expect(JSON.stringify(template.toJSON())).not.toMatch(/s3:GetObject|dynamodb:GetItem|ssm:GetParameter/);
    template.hasResourceProperties("AWS::Events::Rule", { ScheduleExpression: "rate(5 minutes)" });
    template.hasResourceProperties("AWS::CloudWatch::Alarm", { AlarmName: "self-healing-agent-test-readonly-access", TreatMissingData: "breaching" });
    template.resourceCountIs("AWS::ApiGatewayV2::Api", 1);
    template.resourceCountIs("AWS::SecretsManager::Secret", 1);
  });
});

describe("MappingStack", () => {
  const build = (overrides: Record<string, unknown> = {}) =>
    new MappingStack(new App(), "Mapping", {
      stage: "test",
      mappingId: "owner-repo",
      repository: "owner/repo",
      snsTopicArns: [
        `arn:aws:sns:us-east-1:${ACCOUNT}:alerts-a`,
        `arn:aws:sns:us-east-1:${ACCOUNT}:alerts-b`,
        `arn:aws:sns:us-east-1:${ACCOUNT}:alerts-a`,
      ],
      dispatchEnabled: false,
      sessionCooldownMinutes: 30,
      env: { account: ACCOUNT, region: "us-east-1" },
      ...overrides,
    });

  it("buffers alerts behind one dispatcher with a rate cap and a scheduled flush", () => {
    const template = Template.fromStack(build());
    template.hasResourceProperties("AWS::Lambda::EventSourceMapping", {
      BatchSize: 100,
      MaximumBatchingWindowInSeconds: 300,
      FunctionResponseTypes: ["ReportBatchItemFailures"],
      Enabled: false,
    });
    template.hasResourceProperties("AWS::Lambda::Function", { ReservedConcurrentExecutions: 1 });
    template.hasResourceProperties("AWS::Lambda::Function", {
      Environment: { Variables: { SESSION_COOLDOWN_MINUTES: "30" } },
    });
    template.hasResourceProperties("AWS::SQS::Queue", { VisibilityTimeout: 1200 });
    template.hasResourceProperties("AWS::Events::Rule", { ScheduleExpression: "rate(5 minutes)", State: "DISABLED" });
    template.resourceCountIs("AWS::Events::Rule", 1);
    template.resourceCountIs("AWS::SQS::Queue", 2);
    template.resourceCountIs("AWS::SNS::Subscription", 2);
    template.resourceCountIs("AWS::DynamoDB::Table", 1);
    template.resourceCountIs("AWS::SecretsManager::Secret", 3);
    template.hasResourceProperties("AWS::ApiGatewayV2::Route", { RouteKey: "POST /incidents/pr" });
    template.hasResourceProperties("AWS::ApiGatewayV2::Route", { RouteKey: "GET /incidents/pr" });
    template.hasResourceProperties("AWS::Logs::MetricFilter", { FilterPattern: '"incident_launch_uncertain"' });
    template.hasResourceProperties("AWS::Logs::MetricFilter", { FilterPattern: '"incident_alert_quarantined"' });
    template.hasOutput("CodeTelemetryEnvironment", { Value: "self-healing-agent" });
    template.hasOutput("CodeTelemetryResourceAttributes", { Value: "env=self-healing-agent,deployment.environment=claude-cloud,self_healing.mapping_id=owner-repo,self_healing.stage=test" });
  });

  it("carries no OAuth or organization-UUID configuration on the dispatcher", () => {
    const template = Template.fromStack(build());
    const dispatchers = template.findResources("AWS::Lambda::Function", {
      Properties: { Environment: { Variables: { SESSION_COOLDOWN_MINUTES: "30" } } },
    });
    const env = Object.values(dispatchers)[0]?.Properties?.Environment?.Variables ?? {};
    expect(env).not.toHaveProperty("CLAUDE_CODE_ORGANIZATION_UUID");
    expect(env).not.toHaveProperty("CLAUDE_OAUTH_SECRET_ARN");
    expect(env).not.toHaveProperty("INCIDENT_GUIDANCE");
  });

  it("configures anti-flap knobs with defaults on the dispatcher and webhook", () => {
    const template = Template.fromStack(build());
    template.hasResourceProperties("AWS::Lambda::Function", {
      Environment: {
        Variables: {
          ALARM_BACKOFF_BASE_MINUTES: "120",
          ALARM_BACKOFF_MAX_MINUTES: "1440",
          SESSION_DAILY_BUDGET: "8",
          SESSION_BUDGET_WINDOW_MINUTES: "1440",
        },
      },
    });
    template.hasResourceProperties("AWS::Lambda::Function", {
      Environment: {
        Variables: {
          MERGED_SUPPRESSION_MINUTES: "240",
          KNOWN_ISSUE_SUPPRESSION_MINUTES: "10080",
        },
      },
    });
  });

  it("rejects a backoff max below the base", () => {
    expect(() => build({ alarmBackoffBaseMinutes: 240, alarmBackoffMaxMinutes: 120 })).toThrow(/alarmBackoffMax/);
  });

  it("passes deployment-supplied incident guidance to the dispatcher", () => {
    const template = Template.fromStack(build({ incidentGuidance: ["Branch off main.", "Never self-merge."] }));
    template.hasResourceProperties("AWS::Lambda::Function", {
      Environment: { Variables: { INCIDENT_GUIDANCE: "Branch off main.\nNever self-merge." } },
    });
  });

  it("rejects incomplete repository names", () => {
    expect(() => build({ repository: "not-a-repo" })).toThrow(/owner\/name/);
  });

  it("rejects a max session age below the cooldown", () => {
    expect(() => build({ sessionCooldownMinutes: 60, sessionMaxAgeMinutes: 30 })).toThrow(/sessionMaxAgeMinutes/);
  });
});


describe("scoped diagnostics", () => {
  it("scopes optional log reads to explicit groups and rejects wildcard groups", () => {
    const stack = new FoundationStack(new App(), "Logs", {
      stage: "test", diagnosticLogGroupArns: ["arn:aws:logs:us-east-1:111122223333:log-group:/target/service"],
    });
    Template.fromStack(stack).hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: { Statement: Match.arrayWith([Match.objectLike({
        Action: Match.arrayWith(["logs:FilterLogEvents"]),
        Resource: ["arn:aws:logs:us-east-1:111122223333:log-group:/target/service", "arn:aws:logs:us-east-1:111122223333:log-group:/target/service:*"],
      })]) },
    });
    expect(() => new FoundationStack(new App(), "BadLogs", { stage: "test", diagnosticLogGroupArns: ["*"] })).toThrow(/explicit log-group/);
  });
});
