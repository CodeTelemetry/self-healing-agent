output "check_ids" {
  description = "IDs of the Grader draft checks this configuration manages."
  value       = [for check in local.self_healing_checks : check.id]
}

output "draft_revision" {
  description = "Server revision of the workspace Grader draft after the last apply; pass it to backtests."
  value       = codetelemetry_grader_config.self_healing.revision
}

output "environment" {
  description = "OpenTelemetry env tag the checks are scoped to."
  value       = var.environment
}
