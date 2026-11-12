import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  type StackProps,
  aws_apigatewayv2 as apigwv2,
  aws_apigatewayv2_integrations as integrations,
  aws_cloudwatch as cloudwatch,
  aws_dynamodb as dynamodb,
  aws_events as events,
  aws_events_targets as eventTargets,
  aws_lambda as lambda,
  aws_lambda_event_sources as eventSources,
  aws_logs as logs,
  aws_secretsmanager as secretsmanager,
  aws_sns as sns,
  aws_sns_subscriptions as subscriptions,
  aws_sqs as sqs,
} from "aws-cdk-lib";
import { Construct } from "constructs";
import { lambdaAsset } from "./lambda-asset.js";
import { telemetryConfiguration } from "../src/domain/telemetry.js";

export interface MappingStackProps extends StackProps {
  stage: string;
  mappingId: string;
  repository: string;
  telemetryEnvironment?: string;
  snsTopicArns: string[];
  dispatchEnabled?: boolean;
  // Invocation-rate cap: minimum minutes between self-healing session starts.
  sessionCooldownMinutes?: number;
  // An ACTIVE/PR_OPEN session older than this is treated as abandoned so the
  // buffer is not blocked forever by a session that never merged or closed.
  sessionMaxAgeMinutes?: number;
  // Deployment-specific incident-prompt lines appended to the generic controller
  // guidance (branch naming, review triggers, merge policy). The library itself
  // names no repository or product.
  incidentGuidance?: string[];
  // Anti-flap. Per-alarm suppression backoff after the controller handles an
  // alarm (exponential, capped), reset after a quiet gap; a global cap on
  // session starts per rolling window; and post-disposition suppression when a
  // PR merges or is closed as a known issue.
  alarmBackoffBaseMinutes?: number;
  alarmBackoffMaxMinutes?: number;
  alarmBackoffResetMinutes?: number;
  sessionDailyBudget?: number;
  sessionBudgetWindowMinutes?: number;
  mergedSuppressionMinutes?: number;
  knownIssueSuppressionMinutes?: number;
}

export class MappingStack extends Stack {
  constructor(scope: Construct, id: string, props: MappingStackProps) {
    super(scope, id, props);
    const telemetry = telemetryConfiguration({ environment: props.telemetryEnvironment, mappingId: props.mappingId, stage: props.stage });

    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(props.repository)) {
      throw new Error("repository must be in owner/name form");
    }
    const topicArns = [...new Set(props.snsTopicArns)];
    if (topicArns.length === 0) {
      throw new Error("snsTopicArns must contain at least one SNS topic ARN");
    }
    if (topicArns.some((arn) => !/^arn:[^:]+:sns:[^:]+:\d{12}:[A-Za-z0-9_-]+$/.test(arn))) {
      throw new Error("every snsTopicArns entry must be an SNS topic ARN");
    }
    if (new Set(topicArns.map((arn) => arn.split(":")[3])).size !== 1) {
      throw new Error("all snsTopicArns entries must be in the same AWS Region");
    }
    const sessionCooldownMinutes = props.sessionCooldownMinutes ?? 30;
    const sessionMaxAgeMinutes = props.sessionMaxAgeMinutes ?? 360;
    if (!Number.isFinite(sessionCooldownMinutes) || sessionCooldownMinutes <= 0) {
      throw new Error("sessionCooldownMinutes must be a positive number");
    }
    if (!Number.isFinite(sessionMaxAgeMinutes) || sessionMaxAgeMinutes <= sessionCooldownMinutes) {
      throw new Error("sessionMaxAgeMinutes must be greater than sessionCooldownMinutes");
    }
    const alarmBackoffBaseMinutes = props.alarmBackoffBaseMinutes ?? 120;
    const alarmBackoffMaxMinutes = props.alarmBackoffMaxMinutes ?? 1440;
    const alarmBackoffResetMinutes = props.alarmBackoffResetMinutes ?? 1440;
    const sessionDailyBudget = props.sessionDailyBudget ?? 8;
    const sessionBudgetWindowMinutes = props.sessionBudgetWindowMinutes ?? 1440;
    const mergedSuppressionMinutes = props.mergedSuppressionMinutes ?? 240;
    const knownIssueSuppressionMinutes = props.knownIssueSuppressionMinutes ?? 7 * 24 * 60;
    if (alarmBackoffMaxMinutes < alarmBackoffBaseMinutes) {
      throw new Error("alarmBackoffMaxMinutes must be >= alarmBackoffBaseMinutes");
    }
    if (!Number.isFinite(sessionDailyBudget) || sessionDailyBudget < 1) {
      throw new Error("sessionDailyBudget must be a positive number");
    }

    const state = new dynamodb.Table(this, "State", {
      tableName: `self-healing-agent-${props.stage}-${props.mappingId}`,
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: true,
      },
      timeToLiveAttribute: "expiresAt",
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const routineSecret = new secretsmanager.Secret(this, "RoutineSecret", {
      secretName: `/self-healing-agent/${props.stage}/${props.mappingId}/claude-routine`,
      description: "Claude routine fire URL and per-routine token; replace generated placeholders during setup",
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ url: "https://api.anthropic.com/configure-me" }),
        generateStringKey: "token",
        passwordLength: 48,
        excludePunctuation: true,
      },
    });
    const webhookSecret = new secretsmanager.Secret(this, "GithubWebhookSecret", {
      secretName: `/self-healing-agent/${props.stage}/${props.mappingId}/github-webhook`,
      description: "HMAC secret for the target repository pull_request webhook",
      generateSecretString: {
        secretStringTemplate: "{}",
        generateStringKey: "token",
        passwordLength: 48,
        excludePunctuation: true,
      },
    });
    const registrationSecret = new secretsmanager.Secret(this, "PrRegistrationSecret", {
      secretName: `/self-healing-agent/${props.stage}/${props.mappingId}/pr-registration`,
      description: "Dedicated capability for registering the active incident PR and checkout head",
      generateSecretString: { secretStringTemplate: "{}", generateStringKey: "token", passwordLength: 48, excludePunctuation: true },
    });

    const deadLetterQueue = new sqs.Queue(this, "IncidentDeadLetterQueue", {
      queueName: `self-healing-agent-${props.stage}-${props.mappingId}-dlq`,
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      retentionPeriod: Duration.days(14),
    });
    const queue = new sqs.Queue(this, "IncidentQueue", {
      queueName: `self-healing-agent-${props.stage}-${props.mappingId}`,
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      visibilityTimeout: Duration.minutes(20),
      retentionPeriod: Duration.days(14),
      deadLetterQueue: { queue: deadLetterQueue, maxReceiveCount: 5 },
    });
    topicArns.forEach((topicArn, index) => {
      const topic = sns.Topic.fromTopicArn(this, `IncidentTopic${index + 1}`, topicArn);
      topic.addSubscription(new subscriptions.SqsSubscription(queue, { rawMessageDelivery: false }));
    });

    const dispatcherLogs = new logs.LogGroup(this, "DispatcherLogs", {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const dispatcher = new lambda.Function(this, "Dispatcher", {
      runtime: lambda.Runtime.NODEJS_22_X,
      code: lambda.Code.fromAsset(lambdaAsset("dispatcher")),
      handler: "index.handler",
      timeout: Duration.minutes(1),
      memorySize: 512,
      reservedConcurrentExecutions: 1,
      architecture: lambda.Architecture.X86_64,
      logGroup: dispatcherLogs,
      environment: {
        STATE_TABLE_NAME: state.tableName,
        REPOSITORY: props.repository,
        SNS_TOPIC_ARNS: topicArns.join(","),
        ROUTINE_SECRET_ARN: routineSecret.secretArn,
        SESSION_COOLDOWN_MINUTES: String(sessionCooldownMinutes),
        SESSION_MAX_AGE_MINUTES: String(sessionMaxAgeMinutes),
        ALARM_BACKOFF_BASE_MINUTES: String(alarmBackoffBaseMinutes),
        ALARM_BACKOFF_MAX_MINUTES: String(alarmBackoffMaxMinutes),
        ALARM_BACKOFF_RESET_MINUTES: String(alarmBackoffResetMinutes),
        SESSION_DAILY_BUDGET: String(sessionDailyBudget),
        SESSION_BUDGET_WINDOW_MINUTES: String(sessionBudgetWindowMinutes),
        ...(props.incidentGuidance && props.incidentGuidance.length > 0
          ? { INCIDENT_GUIDANCE: props.incidentGuidance.join("\n") }
          : {}),
      },
    });
    dispatcher.addEventSource(
      new eventSources.SqsEventSource(queue, {
        batchSize: 100,
        maxBatchingWindow: Duration.minutes(5),
        reportBatchItemFailures: true,
        enabled: props.dispatchEnabled ?? true,
      }),
    );
    // Scheduled flush: drains buffered alerts into a new session once the gate
    // opens even if no fresh alarm arrives (e.g. shortly after a PR merges).
    // Shares the dispatcher's reserved concurrency of 1, so a flush and an SQS
    // batch never run at the same time.
    new events.Rule(this, "FlushSchedule", {
      schedule: events.Schedule.rate(Duration.minutes(5)),
      // Paused together with the SQS trigger: when dispatch is off, no session
      // starts by any path.
      enabled: props.dispatchEnabled ?? true,
      targets: [new eventTargets.LambdaFunction(dispatcher)],
    });
    state.grantReadWriteData(dispatcher);
    routineSecret.grantRead(dispatcher);
    for (const [id, event, description] of [
      ["UncertainLaunch", "incident_launch_uncertain", "Routine launch outcome is unknown; verify routine history and reconcile the reserved delivery"],
      ["QuarantinedAlert", "incident_alert_quarantined", "An alert exceeds the payload budget and needs operator review in the quarantine partition"],
      ["BatchFailure", "incident_batch_failed", "An incident batch contains retryable dispatcher or ingestion failures"],
    ] as const) {
      const metric = new logs.MetricFilter(this, `${id}Metric`, {
        logGroup: dispatcherLogs, filterPattern: logs.FilterPattern.allTerms(event),
        metricNamespace: "SelfHealingAgent", metricName: `${props.stage}-${props.mappingId}-${id}`, metricValue: "1",
      });
      new cloudwatch.Alarm(this, `${id}Alarm`, {
        metric: metric.metric({ statistic: "Sum", period: Duration.minutes(5) }), threshold: 1, evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING, alarmDescription: description,
      });
    }

    const webhookLogs = new logs.LogGroup(this, "WebhookLogs", {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const webhook = new lambda.Function(this, "GithubWebhook", {
      runtime: lambda.Runtime.NODEJS_22_X,
      code: lambda.Code.fromAsset(lambdaAsset("github-webhook")),
      handler: "index.handler",
      timeout: Duration.seconds(20),
      memorySize: 256,
      logGroup: webhookLogs,
      environment: {
        STATE_TABLE_NAME: state.tableName,
        REPOSITORY: props.repository,
        GITHUB_WEBHOOK_SECRET_ARN: webhookSecret.secretArn,
        MERGED_SUPPRESSION_MINUTES: String(mergedSuppressionMinutes),
        KNOWN_ISSUE_SUPPRESSION_MINUTES: String(knownIssueSuppressionMinutes),
      },
      architecture: lambda.Architecture.X86_64,
    });
    state.grant(webhook, "dynamodb:GetItem", "dynamodb:UpdateItem");
    webhookSecret.grantRead(webhook);

    const webhookAccessLogs = new logs.LogGroup(this, "WebhookAccessLogs", {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const webhookApi = new apigwv2.HttpApi(this, "GithubWebhookApi", {
      apiName: `self-healing-agent-${props.stage}-${props.mappingId}-github`,
      createDefaultStage: true,
    });
    webhookApi.addRoutes({
      path: "/github",
      methods: [apigwv2.HttpMethod.POST],
      integration: new integrations.HttpLambdaIntegration("WebhookIntegration", webhook),
    });
    const registration = new lambda.Function(this, "PrRegistration", {
      runtime: lambda.Runtime.NODEJS_22_X, handler: "index.handler",
      code: lambda.Code.fromAsset(lambdaAsset("pr-registration")),
      timeout: Duration.seconds(20), memorySize: 256,
      logGroup: new logs.LogGroup(this, "PrRegistrationLogs", { retention: logs.RetentionDays.ONE_MONTH, removalPolicy: RemovalPolicy.DESTROY }),
      environment: {
        STATE_TABLE_NAME: state.tableName, REPOSITORY: props.repository,
        PR_REGISTRATION_SECRET_ARN: registrationSecret.secretArn,
      },
    });
    state.grant(registration, "dynamodb:GetItem", "dynamodb:UpdateItem");
    registrationSecret.grantRead(registration);
    webhookApi.addRoutes({
      path: "/incidents/pr", methods: [apigwv2.HttpMethod.POST, apigwv2.HttpMethod.GET],
      integration: new integrations.HttpLambdaIntegration("RegistrationIntegration", registration),
    });
    const webhookStage = webhookApi.defaultStage?.node.defaultChild as apigwv2.CfnStage | undefined;
    if (webhookStage) {
      webhookStage.defaultRouteSettings = { throttlingBurstLimit: 20, throttlingRateLimit: 10 };
      webhookStage.accessLogSettings = {
        destinationArn: webhookAccessLogs.logGroupArn,
        format: '{"requestId":"$context.requestId","status":"$context.status","routeKey":"$context.routeKey"}',
      };
    }

    new cloudwatch.Alarm(this, "DeadLetterQueueAlarm", {
      metric: deadLetterQueue.metricApproximateNumberOfMessagesVisible({ period: Duration.minutes(5) }),
      threshold: 1,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: "Incident alerts exhausted retries and reached the self-healing-agent DLQ",
    });
    new cloudwatch.Alarm(this, "DispatcherErrorsAlarm", {
      metric: dispatcher.metricErrors({ period: Duration.minutes(5) }),
      threshold: 1,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    new cloudwatch.Alarm(this, "WebhookErrorsAlarm", {
      metric: webhook.metricErrors({ period: Duration.minutes(5) }),
      threshold: 1,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    new cloudwatch.Alarm(this, "RegistrationErrorsAlarm", {
      metric: registration.metricErrors({ period: Duration.minutes(5) }), threshold: 1, evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    new CfnOutput(this, "GithubWebhookUrl", { value: `${webhookApi.apiEndpoint}/github` });
    new CfnOutput(this, "GithubWebhookSecretArn", { value: webhookSecret.secretArn });
    new CfnOutput(this, "RoutineSecretArn", { value: routineSecret.secretArn });
    new CfnOutput(this, "StateTableName", { value: state.tableName });
    new CfnOutput(this, "IncidentQueueUrl", { value: queue.queueUrl });
    new CfnOutput(this, "CodeTelemetryEnvironment", { value: telemetry.environment });
    new CfnOutput(this, "CodeTelemetryResourceAttributes", { value: telemetry.resourceAttributes });
    new CfnOutput(this, "PrRegistrationUrl", { value: `${webhookApi.apiEndpoint}/incidents/pr` });
    new CfnOutput(this, "PrRegistrationSecretArn", { value: registrationSecret.secretArn });
  }
}
