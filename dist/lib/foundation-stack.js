import { CfnOutput, Duration, RemovalPolicy, Stack, aws_apigatewayv2 as apigwv2, aws_apigatewayv2_integrations as integrations, aws_cloudwatch as cloudwatch, aws_events as events, aws_events_targets as eventTargets, aws_iam as iam, aws_lambda as lambda, aws_logs as logs, aws_secretsmanager as secretsmanager, } from "aws-cdk-lib";
import { lambdaAsset } from "./lambda-asset.js";
export class FoundationStack extends Stack {
    brokerUrl;
    brokerTokenSecretArn;
    readOnlyRoleArn;
    constructor(scope, id, props) {
        super(scope, id, props);
        const brokerToken = new secretsmanager.Secret(this, "BrokerToken", {
            secretName: `/self-healing-agent/${props.stage}/broker-token`,
            description: "Revocable token used by Claude cloud sessions to request short-lived AWS credentials",
            generateSecretString: {
                secretStringTemplate: "{}",
                generateStringKey: "token",
                passwordLength: 48,
                excludePunctuation: true,
            },
        });
        const brokerRole = new iam.Role(this, "BrokerExecutionRole", {
            assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole"),
            ],
        });
        const claudeReadOnlyRole = new iam.Role(this, "ClaudeReadOnlyRole", {
            roleName: `self-healing-agent-${props.stage}-claude-readonly`,
            description: "Short-lived CloudWatch diagnostics sessions; no general application-data read access",
            assumedBy: new iam.ArnPrincipal(brokerRole.roleArn),
            maxSessionDuration: Duration.hours(1),
        });
        claudeReadOnlyRole.addToPolicy(new iam.PolicyStatement({
            actions: ["cloudwatch:DescribeAlarms", "cloudwatch:DescribeAlarmHistory", "cloudwatch:GetMetricData", "cloudwatch:GetMetricStatistics", "cloudwatch:ListMetrics"],
            resources: ["*"],
        }));
        for (const suppliedArn of props.diagnosticLogGroupArns ?? []) {
            const arn = suppliedArn.replace(/:\*$/, "");
            if (!/^arn:[a-z-]+:logs:[a-z0-9-]+:\d{12}:log-group:[A-Za-z0-9/_.-]+$/.test(arn)) {
                throw new Error("diagnosticLogGroupArns must contain explicit log-group ARNs without wildcards");
            }
            claudeReadOnlyRole.addToPolicy(new iam.PolicyStatement({
                actions: ["logs:FilterLogEvents", "logs:GetLogEvents", "logs:DescribeLogStreams"],
                resources: [arn, `${arn}:*`],
            }));
        }
        claudeReadOnlyRole.assumeRolePolicy?.addStatements(new iam.PolicyStatement({
            actions: ["sts:TagSession", "sts:SetSourceIdentity"],
            principals: [new iam.ArnPrincipal(brokerRole.roleArn)],
        }));
        brokerRole.addToPolicy(new iam.PolicyStatement({
            actions: ["sts:AssumeRole", "sts:TagSession", "sts:SetSourceIdentity"],
            resources: [claudeReadOnlyRole.roleArn],
        }));
        brokerToken.grantRead(brokerRole);
        const brokerLogGroup = new logs.LogGroup(this, "BrokerLogGroup", {
            retention: logs.RetentionDays.ONE_MONTH,
            removalPolicy: RemovalPolicy.DESTROY,
        });
        const broker = new lambda.Function(this, "CredentialBroker", {
            runtime: lambda.Runtime.NODEJS_22_X,
            code: lambda.Code.fromAsset(lambdaAsset("credential-broker")),
            handler: "index.handler",
            timeout: Duration.seconds(20),
            memorySize: 256,
            role: brokerRole,
            logGroup: brokerLogGroup,
            environment: {
                BROKER_TOKEN_SECRET_ARN: brokerToken.secretArn,
                READ_ONLY_ROLE_ARN: claudeReadOnlyRole.roleArn,
            },
            architecture: lambda.Architecture.X86_64,
        });
        const accessLogs = new logs.LogGroup(this, "BrokerAccessLogs", {
            retention: logs.RetentionDays.ONE_MONTH,
            removalPolicy: RemovalPolicy.DESTROY,
        });
        const api = new apigwv2.HttpApi(this, "CredentialBrokerApi", {
            apiName: `self-healing-agent-${props.stage}-credential-broker`,
            createDefaultStage: true,
        });
        api.addRoutes({
            path: "/v1/credentials",
            methods: [apigwv2.HttpMethod.GET],
            integration: new integrations.HttpLambdaIntegration("BrokerIntegration", broker),
        });
        const defaultStage = api.defaultStage?.node.defaultChild;
        if (defaultStage) {
            defaultStage.defaultRouteSettings = { throttlingBurstLimit: 10, throttlingRateLimit: 5 };
            defaultStage.accessLogSettings = {
                destinationArn: accessLogs.logGroupArn,
                format: '{"requestId":"$context.requestId","status":"$context.status","routeKey":"$context.routeKey","responseLength":"$context.responseLength"}',
            };
        }
        new cloudwatch.Alarm(this, "BrokerErrorsAlarm", {
            metric: broker.metricErrors({ period: Duration.minutes(5) }),
            threshold: 1,
            evaluationPeriods: 1,
            treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
            alarmDescription: "The Claude AWS credential broker returned an unhandled Lambda error",
        });
        const health = new lambda.Function(this, "AccessHealth", {
            runtime: lambda.Runtime.NODEJS_22_X,
            code: lambda.Code.fromAsset(lambdaAsset("access-health")),
            handler: "index.handler",
            timeout: Duration.seconds(90),
            memorySize: 256,
            environment: {
                STAGE: props.stage,
                BROKER_URL: `${api.apiEndpoint}/v1/credentials`,
                BROKER_TOKEN_SECRET_ARN: brokerToken.secretArn,
                READ_ONLY_ROLE_ARN: claudeReadOnlyRole.roleArn,
            },
        });
        brokerToken.grantRead(health);
        health.addToRolePolicy(new iam.PolicyStatement({
            actions: ["cloudwatch:PutMetricData"],
            resources: ["*"],
            conditions: { StringEquals: { "cloudwatch:namespace": "SelfHealingAgent" } },
        }));
        new events.Rule(this, "AccessHealthSchedule", {
            schedule: events.Schedule.rate(Duration.minutes(5)),
            targets: [new eventTargets.LambdaFunction(health)],
        });
        new cloudwatch.Alarm(this, "ReadOnlyAccessHealthAlarm", {
            alarmName: `self-healing-agent-${props.stage}-readonly-access`,
            metric: new cloudwatch.Metric({
                namespace: "SelfHealingAgent",
                metricName: "ReadOnlyAccessHealthy",
                dimensionsMap: { Stage: props.stage },
                statistic: "Minimum",
                period: Duration.minutes(5),
            }),
            threshold: 1,
            comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
            evaluationPeriods: 2,
            treatMissingData: cloudwatch.TreatMissingData.BREACHING,
            alarmDescription: "Public credential broker, STS identity, or production CloudWatch read failed (or monitor stopped). Does not validate Claude VM configuration or egress.",
        });
        const authDenied = new logs.MetricFilter(this, "BrokerAuthDeniedMetric", {
            logGroup: brokerLogGroup,
            filterPattern: logs.FilterPattern.literal('{ $.event = "broker_auth_denied" }'),
            metricNamespace: "SelfHealingAgent",
            metricName: `BrokerAuthDenied-${props.stage}`,
            metricValue: "1",
        });
        new cloudwatch.Alarm(this, "BrokerAuthDeniedAlarm", {
            alarmName: `self-healing-agent-${props.stage}-broker-auth-denied`,
            metric: authDenied.metric({ statistic: "Sum", period: Duration.minutes(5) }),
            threshold: 1,
            evaluationPeriods: 1,
            treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
            alarmDescription: "A credential broker client presented a missing or invalid token. Check the Claude cloud environment.",
        });
        this.brokerUrl = `${api.apiEndpoint}/v1/credentials`;
        this.brokerTokenSecretArn = brokerToken.secretArn;
        this.readOnlyRoleArn = claudeReadOnlyRole.roleArn;
        new CfnOutput(this, "BrokerUrl", { value: this.brokerUrl });
        new CfnOutput(this, "BrokerTokenSecretArn", { value: this.brokerTokenSecretArn });
        new CfnOutput(this, "ClaudeReadOnlyRoleArn", { value: this.readOnlyRoleArn });
    }
}
