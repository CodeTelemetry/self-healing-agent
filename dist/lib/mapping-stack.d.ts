import { Stack, type StackProps } from "aws-cdk-lib";
import { Construct } from "constructs";
export interface MappingStackProps extends StackProps {
    stage: string;
    mappingId: string;
    repository: string;
    telemetryEnvironment?: string;
    snsTopicArns: string[];
    dispatchEnabled?: boolean;
    sessionCooldownMinutes?: number;
    sessionMaxAgeMinutes?: number;
    incidentGuidance?: string[];
    alarmBackoffBaseMinutes?: number;
    alarmBackoffMaxMinutes?: number;
    alarmBackoffResetMinutes?: number;
    sessionDailyBudget?: number;
    sessionBudgetWindowMinutes?: number;
    mergedSuppressionMinutes?: number;
    knownIssueSuppressionMinutes?: number;
}
export declare class MappingStack extends Stack {
    constructor(scope: Construct, id: string, props: MappingStackProps);
}
