export const DEFAULT_TELEMETRY_ENVIRONMENT = "self-healing-agent";

export interface TelemetryScope {
  environment?: string | undefined;
  mappingId?: string | undefined;
  stage?: string | undefined;
}

function attributeValue(name: string, value: string, maxLength: number): string {
  if (!value || value.length > maxLength || !/^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/.test(value)) {
    throw new Error(`${name} must be a nonempty telemetry attribute value of at most ${maxLength} supported characters`);
  }
  return value;
}

export function telemetryConfiguration(scope: TelemetryScope = {}) {
  const environment = attributeValue("environment", scope.environment ?? DEFAULT_TELEMETRY_ENVIRONMENT, 64);
  if ((scope.mappingId === undefined) !== (scope.stage === undefined)) {
    throw new Error("mappingId and stage must be supplied together for telemetry attribution");
  }
  const attributes = [`env=${environment}`, "deployment.environment=claude-cloud"];
  if (scope.mappingId !== undefined && scope.stage !== undefined) {
    attributes.push(
      `self_healing.mapping_id=${attributeValue("mappingId", scope.mappingId, 128)}`,
      `self_healing.stage=${attributeValue("stage", scope.stage, 64)}`,
    );
  }
  return { environment, resourceAttributes: attributes.join(",") };
}
