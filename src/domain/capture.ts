export function captureConfiguration(options: { content?: boolean; rawApiBodies?: boolean } = {}) {
  if (options.rawApiBodies && !options.content) throw new Error("Raw API body capture requires explicit content capture opt-in");
  return {
    OTEL_LOG_USER_PROMPTS: options.content ? "1" : "0",
    OTEL_LOG_TOOL_DETAILS: "1",
    OTEL_LOG_TOOL_CONTENT: options.content ? "1" : "0",
    OTEL_LOG_RAW_API_BODIES: options.rawApiBodies ? "1" : "0",
  };
}
