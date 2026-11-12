import { Stack, type StackProps } from "aws-cdk-lib";
import { Construct } from "constructs";
export interface FoundationStackProps extends StackProps {
    stage: string;
    diagnosticLogGroupArns?: string[];
}
export declare class FoundationStack extends Stack {
    readonly brokerUrl: string;
    readonly brokerTokenSecretArn: string;
    readonly readOnlyRoleArn: string;
    constructor(scope: Construct, id: string, props: FoundationStackProps);
}
