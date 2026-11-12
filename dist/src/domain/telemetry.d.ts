export declare const DEFAULT_TELEMETRY_ENVIRONMENT = "self-healing-agent";
export interface TelemetryScope {
    environment?: string | undefined;
    mappingId?: string | undefined;
    stage?: string | undefined;
}
export declare function telemetryConfiguration(scope?: TelemetryScope): {
    environment: string;
    resourceAttributes: string;
};
