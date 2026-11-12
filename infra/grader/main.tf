# Uses the repository's Connect/MCP workspace binding or CODETELEMETRY_WORKSPACE.
# Legacy CODETELEMETRY_ENDPOINT / CODETELEMETRY_TOKEN authentication also works.
provider "codetelemetry" {}

locals {
  check_templates = jsondecode(file("${path.module}/checks.json"))
  # checks.json keeps the three PR alternatives in this catalog order.
  pull_request_action_order = ["create", "update", "comment"]
  pull_request_template     = one([for check in local.check_templates : check if check.id == "self-healing.pull-request"])
  pull_request_matchers     = zipmap(local.pull_request_action_order, local.pull_request_template.matcherRule.include.any)
  self_healing_checks = [for check in local.check_templates : merge(
    check,
    { environment = var.environment },
    var.repository_id == null ? {} : { repositoryId = var.repository_id },
    check.id == "self-healing.pull-request" ? {
      matcherRule = merge(check.matcherRule, { include = { any = [
        for action in local.pull_request_action_order : local.pull_request_matchers[action]
        if contains(var.pull_request_actions, action)
      ] } })
    } : {},
  )]
}

# Applying saves these checks to the workspace's Grader draft. Publishing the
# draft is a separate step outside Terraform.
resource "codetelemetry_grader_config" "self_healing" {
  checks_json = jsonencode(local.self_healing_checks)
}
