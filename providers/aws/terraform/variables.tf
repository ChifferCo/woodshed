variable "region" {
  type    = string
  default = "us-east-1"
}

# No default for the values that name one installation: an apply without its -var-file fails on them, naming them,
# rather than using another installation's.
variable "domain" {
  description = "The console's name, given its own Route 53 zone (dns.tf)."
  type        = string
}

variable "budget_email" {
  description = "Who gets the budget alerts at 80% and 100% of the monthly limit."
  type        = string
}

variable "monthly_budget_usd" {
  type    = number
  default = 150
}

variable "github_repo" {
  description = "The repository sessions work on, owner/name; the GitHub roles trust its workflows (github.tf)."
  type        = string
}

# Empty, the default, leaves the console on github_repo alone, as before projects (console/projects.mjs).
variable "projects" {
  description = "The repos the console starts sessions on, handed to it as WOODSHED_CLOUD_PROJECTS: each with a name (lowercase words joined by single dashes, at most 32 long), its repo (owner/name), whether it is the default, and, when the App is installed on its repo's account under another installation, that installation's ID. [] (the default) for github_repo alone. Every project uses this installation's session image, task definition and databases for now."
  type = list(object({
    name            = string
    repo            = string
    default         = optional(bool, false)
    installation_id = optional(string)
  }))
  default = []

  validation {
    condition     = alltrue([for p in var.projects : can(regex("^[a-z0-9]+(-[a-z0-9]+)*$", p.name)) && length(p.name) <= 32])
    error_message = "A project's name is lowercase letters and digits, in words joined by single dashes, at most 32 long."
  }
  validation {
    condition     = alltrue([for p in var.projects : can(regex("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", p.repo))])
    error_message = "A project's repo is owner/name."
  }
  validation {
    condition     = alltrue([for p in var.projects : p.installation_id == null || can(regex("^[0-9]+$", p.installation_id))])
    error_message = "A project's installation_id is the GitHub App installation's number."
  }
  validation {
    condition = (length(distinct([for p in var.projects : p.name])) == length(var.projects)
    && length(distinct([for p in var.projects : lower(p.repo)])) == length(var.projects))
    error_message = "Each project has a name and a repo of its own."
  }
  validation {
    condition     = length(var.projects) <= 1 || length([for p in var.projects : p if p.default]) == 1
    error_message = "With more than one project, exactly one is the default."
  }
  # WOODSHED_CLOUD_REPO stays github_repo, and the console refuses a list whose default is another repo.
  validation {
    condition     = length(var.projects) == 0 || anytrue([for p in var.projects : lower(p.repo) == lower(var.github_repo) && (p.default || length(var.projects) == 1)])
    error_message = "The default project's repo is github_repo."
  }
}

# No default: which databases an installation pays for is its own choice, written in its tfvars.
variable "databases" {
  description = "The database engines the installation hosts for its sessions: \"postgres\" (RDS), \"mongo\" (on the base box), both, or [] for neither, each on its own. Each session gets its own copy of each of the project file's databases, made by the db-admin task, which exists only when one does. Each of the project file's databases needs its engine here."
  type        = list(string)

  validation {
    condition     = alltrue([for d in var.databases : contains(["postgres", "mongo"], d)]) && length(distinct(var.databases)) == length(var.databases)
    error_message = "databases lists each of \"postgres\" and \"mongo\" at most once, and nothing else."
  }
}

variable "database_name" {
  description = "The Postgres database RDS starts with, which nothing uses: the template and every copy are the db-admin task's own. Fixed once RDS exists, since a change replaces it. Left out without postgres in databases."
  type        = string
  default     = null

  validation {
    condition     = (var.database_name != null) == contains(var.databases, "postgres")
    error_message = "database_name is set with postgres in databases, and left out without it."
  }
}

variable "database_user" {
  description = "RDS's master user. The db-admin task is the only thing that logs in as it. Fixed once RDS exists, since a change replaces it. Left out without postgres in databases."
  type        = string
  default     = null

  validation {
    condition     = (var.database_user != null) == contains(var.databases, "postgres")
    error_message = "database_user is set with postgres in databases, and left out without it."
  }
}

variable "env_files" {
  description = "The repo's env files that sessions write, as secret name = path in the repo: the project file's envFiles that have a `secret` (.woodshed/project.yaml). Each becomes a Secrets Manager secret, set on the console's Secrets page, and a variable of the secret's name in capitals in the session task."
  type        = map(string)
}

variable "install_secrets" {
  description = "Secrets the repo's dependency installs read, such as a private package registry's token, as secret name = the variable a session gets it in: the one the repo's own tools read (its .npmrc, say). Each becomes a Secrets Manager secret, set on the console's Secrets page, and a task-definition secret under that variable. The session image's build gets the same variables from its install_env build secret (session/README.md). {} for none."
  type        = map(string)
  default     = {}

  validation {
    condition = alltrue([for name, env_name in var.install_secrets : can(regex("^[a-z0-9-]+$", name)) && !contains(
      ["anthropic-api-key", "openai-api-key", "github-app-key", "github-app-client-secret", "github-webhook-secret", "slack-bot-token", "slack-signing-secret"],
    name) && !contains(keys(var.env_files), name)])
    error_message = "An install secret's name is lowercase letters, digits and dashes, and is not one of the console's own secrets or an env file's."
  }
  validation {
    # Woodshed's own session variables: the same list as SESSION_VARIABLES in shared/reservedNames.mjs.
    condition = alltrue([for env_name in values(var.install_secrets) : can(regex("^[A-Z_][A-Z0-9_]*$", env_name)) && !startswith(env_name, "WOODSHED_") && !contains(
      ["SESSION_ID", "SESSION_TOKEN", "TERMINAL_TOKEN", "SESSION_URL", "SESSION_KIND", "SESSION_MODE", "STARTED_BY", "ISSUE", "PR", "BRANCH", "PROMPT", "ASKED_BY", "AGENT", "MODEL", "EFFORT", "PERMISSION_MODE", "RESUME_SESSION", "ATTACHMENTS", "REVIEW_ONLY", "REPO_DIR", "GH_TOKEN", "ANTHROPIC_API_KEY", "PGHOST", "PGPORT", "PGUSER", "PGPASSWORD", "PGDATABASE", "PGSSLMODE", "PGSSLROOTCERT", "PG_URL", "MONGODB_URI", "HOME", "PATH"],
    env_name) && !contains([for name in keys(var.env_files) : upper(replace(name, "-", "_"))], env_name)]) && length(distinct(values(var.install_secrets))) == length(var.install_secrets)
    error_message = "Each install secret's variable is a different name of capitals, digits and underscores, and not one of Woodshed's own (WOODSHED_*, SESSION_ID, GH_TOKEN, PGHOST and the rest) or an env file's."
  }
}

variable "database_env_secrets" {
  description = "Which of env_files the project's database commands read: every envFiles of the project file's databases. The db-admin task may read these and no others. [] (the default) without databases."
  type        = list(string)
  default     = []

  validation {
    condition     = length(var.databases) > 0 || length(var.database_env_secrets) == 0
    error_message = "database_env_secrets is what the db-admin task's seed reads, and an installation with no databases has no db-admin task."
  }
}

variable "shared_services" {
  description = "Containers the base box runs for every session, such as a fake S3, by name. Each listens on `port` (the same on the box), reaches sessions and the db-admin task as http://<the box>:<port> in `variable`, and gets `environment`. Each of `files` (path in the container = text) is mounted there read-only and executable, for an init script. {} for none."
  type = map(object({
    image       = string
    port        = number
    variable    = string
    environment = optional(map(string), {})
    files       = optional(map(string), {})
    mem_limit   = optional(string, "768m")
  }))

  validation {
    condition     = alltrue([for name, s in var.shared_services : can(regex("^[a-z][a-z0-9-]*$", name)) && !contains(["mongo", "console", "caddy"], name)])
    error_message = "A shared service's name is lowercase letters, digits and dashes, and not mongo, console or caddy, which the base box runs (mongo, with mongo in databases)."
  }
  validation {
    condition     = alltrue([for s in var.shared_services : can(regex("^[A-Z][A-Z0-9_]*_(URL|ENDPOINT)$", s.variable))]) && length(distinct([for s in var.shared_services : s.variable])) == length(var.shared_services)
    error_message = "Each shared service's variable is a different capital name ending in _URL or _ENDPOINT, as S3_ENDPOINT: the db-admin task refuses any other (session/dbAdmin.mjs)."
  }
  validation {
    condition     = alltrue([for s in var.shared_services : !contains([80, 443, 7691, 27017], s.port)]) && length(distinct([for s in var.shared_services : s.port])) == length(var.shared_services)
    error_message = "Each shared service has a port of its own, and not 80, 443, 7691 or 27017, which Caddy, the session API and Mongo use."
  }
  validation {
    condition     = alltrue(flatten([for s in var.shared_services : [for path in keys(s.files) : startswith(path, "/") && !strcontains(path, ":")]]))
    error_message = "A shared service's files are absolute paths in its container, with no colon."
  }
}

# Shared sessions at once until someone changes it on the console's Console settings page. My Woodshed has no limit.
variable "max_sessions" {
  type    = number
  default = 5
}

variable "console_workflow_links" {
  description = "The console menu's GitHub Actions links, label to workflow file in the repo (such as its deploy workflow). None leaves the group out."
  type        = map(string)
  default     = {}

  # The console refuses to start on a bad entry (console/config.mjs, actionsWorkflows), so plan refuses it first. The
  # value also goes unquoted into the base box's compose YAML (baseBoxStack.sh.tftpl), where a colon or a # would break it.
  validation {
    condition = alltrue([
      for label, file in var.console_workflow_links :
      length(trimspace(label)) > 0 && can(regex("^[^,=:#\"]+$", label)) && can(regex("^[A-Za-z0-9._-]+\\.ya?ml$", file))
    ])
    error_message = "Each console_workflow_links entry is a label without , = : # or quotes, and a workflow file name such as images.yml."
  }
}

variable "github_app_id" {
  description = "The Woodshed GitHub App's ID, on its settings page. The console mints every GitHub token with it."
  type        = string

  validation {
    condition     = can(regex("^[0-9]+$", var.github_app_id))
    error_message = "The App ID is a number."
  }
}

variable "github_app_installation_id" {
  description = "The App's installation on the repo's owner: the number at the end of its installation page's URL."
  type        = string

  validation {
    condition     = can(regex("^[0-9]+$", var.github_app_installation_id))
    error_message = "The installation ID is a number."
  }
}

variable "base_box_instance_type" {
  description = "x86, like the session image, so one build serves both."
  type        = string
  default     = "t3.medium"
}
