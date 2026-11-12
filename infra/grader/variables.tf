variable "environment" {
  description = "Exact OpenTelemetry env tag emitted by the self-healing Claude environment."
  type        = string
  default     = "self-healing-agent"
  nullable    = false

  validation {
    condition     = length(var.environment) <= 64 && can(regex("^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$", var.environment))
    error_message = "environment must be a nonempty env tag of at most 64 supported characters."
  }
}

variable "repository_id" {
  description = "Optional repository identity copied from CodeTelemetry session metadata; null covers all repositories in this environment."
  type        = string
  default     = null

  validation {
    condition     = var.repository_id == null ? true : length(trimspace(var.repository_id)) > 0 && trimspace(var.repository_id) == var.repository_id
    error_message = "repository_id must be null or a nonempty, trimmed CodeTelemetry repository identity."
  }
}

variable "pull_request_actions" {
  description = "Allowed alternatives for the single PR-workflow check. Repeated actions never earn additional weight."
  type        = set(string)
  default     = ["create", "update", "comment"]
  nullable    = false

  validation {
    condition     = length(var.pull_request_actions) > 0 && length(setsubtract(var.pull_request_actions, toset(["create", "update", "comment"]))) == 0
    error_message = "Select at least one of create, update, comment."
  }
}
