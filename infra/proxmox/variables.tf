###############################################################################
# Identity
###############################################################################

variable "app_name" {
  description = "Short name: CT hostname, pool, Compose project, /opt/<app_name>, <app_name>ctl, update timer."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,30}[a-z0-9]$", var.app_name))
    error_message = "app_name: 3-32 chars, lowercase letters, digits and dashes, starting with a letter."
  }
}

###############################################################################
# Proxmox connection
###############################################################################

variable "proxmox_endpoint" {
  description = "Proxmox API URL, e.g. https://pve.example.com:8006/"
  type        = string
}

variable "proxmox_api_token_id" {
  description = "API token id (user@realm!tokenid). Not secret."
  type        = string
  default     = "root@pam!terraform"
}

variable "proxmox_api_token" {
  description = "API token secret (the UUID part only). Prefer TF_VAR_proxmox_api_token."
  type        = string
  sensitive   = true
}

variable "proxmox_insecure" {
  description = "Skip TLS verification of the Proxmox API (self-signed certificate)."
  type        = bool
  default     = false
}

variable "node_name" {
  description = "Proxmox node that hosts the container."
  type        = string
}

variable "ssh_host" {
  description = "Address Terraform uses to SSH into the node as root (provider uploads + deployment)."
  type        = string
}

variable "ssh_port" {
  description = "SSH port of the node."
  type        = number
  default     = 22
}

###############################################################################
# Host resources (referenced, not managed: they are shared between projects)
###############################################################################

variable "create_pool" {
  description = "Create a resource pool for this project (named pool_id, or app_name when pool_id is null)."
  type        = bool
  default     = true
}

variable "pool_id" {
  description = "Pool name. With create_pool = false: an existing pool, or null for none."
  type        = string
  default     = null
}

variable "datastore_id" {
  description = "Storage for the CT disks (content type rootdir; vztmpl too if the template is downloaded)."
  type        = string
}

variable "bridge" {
  description = "Existing bridge the CT is attached to."
  type        = string
}

variable "bridge_address" {
  description = "Host address + prefix of the bridge (e.g. 10.10.10.1/24): the CT's gateway and subnet."
  type        = string
}

variable "template_file_id" {
  description = "Existing CT template (storage:vztmpl/file). Null = download var.template_url into datastore_id."
  type        = string
  default     = null
}

variable "template_url" {
  description = "CT template downloaded when template_file_id is null. Debian/Ubuntu only (the ctl script uses apt)."
  type        = string
  default     = "http://download.proxmox.com/images/system/ubuntu-24.04-standard_24.04-2_amd64.tar.zst"
}

###############################################################################
# Container
###############################################################################

variable "vm_id" {
  description = "CT id. No default on purpose: pick a free one (pvesh get /cluster/nextid)."
  type        = number
}

variable "hostname" {
  description = "CT hostname. Null = app_name."
  type        = string
  default     = null
}

variable "ipv4_address" {
  description = "Static address of the CT with prefix, inside bridge_address's subnet."
  type        = string
}

variable "dns_servers" {
  description = "DNS servers for the CT. Empty = inherit the host's resolv.conf."
  type        = list(string)
  default     = []
}

variable "cores" {
  type    = number
  default = 2
}

variable "memory_mb" {
  type    = number
  default = 2048
}

variable "swap_mb" {
  type    = number
  default = 512
}

variable "rootfs_size_gb" {
  description = "Root disk (OS + Docker binaries)."
  type        = number
  default     = 8
}

variable "data_disk_size_gb" {
  description = "Separate volume mounted at /var/lib/docker: images and every named volume."
  type        = number
  default     = 32
}

variable "ssh_public_keys" {
  description = "Optional keys for root inside the CT. Not needed: `pct enter <vmid>` from the host works."
  type        = list(string)
  default     = []
}

variable "protection" {
  description = "Proxmox protection flag: the CT and its disks cannot be removed. Set to false before a destroy/replace."
  type        = bool
  default     = true
}

###############################################################################
# Backups (vzdump)
###############################################################################

variable "backup_storage" {
  description = "Storage (content type `backup`) for a nightly vzdump of the CT. Null = no backup job."
  type        = string
  default     = null
}

variable "backup_schedule" {
  description = "systemd calendar event for the backup job."
  type        = string
  default     = "03:00"
}

variable "backup_retention" {
  description = "vzdump prune policy."
  type        = map(string)
  default = {
    keep-daily  = "7"
    keep-weekly = "4"
  }
}

###############################################################################
# Stack
###############################################################################

variable "compose_file" {
  description = "Project compose file, relative to this directory. Shipped as /opt/<app_name>/compose.yml."
  type        = string
  default     = "../../compose.yml"
}

variable "extra_files" {
  description = <<-EOT
    Other text files the compose file references by relative path: { "<path under /opt/<app_name>>" = "<source
    path relative to this directory>" }. E.g. { "config/nginx.conf" = "../../config/nginx.conf" }.
  EOT
  type        = map(string)
  default     = {}
}

variable "compose_profiles" {
  description = "Compose profiles to enable (the `tunnel` profile is added when a tunnel token is set)."
  type        = list(string)
  default     = []
}

variable "image_tag" {
  description = "Written to .env as IMAGE_TAG; use it in compose.proxmox.yml (`latest`, or `sha-<commit>` to pin)."
  type        = string
  default     = "latest"
}

variable "wait_service" {
  description = "One-shot service (e.g. migrations) the deploy waits for and requires to exit 0. Null = none."
  type        = string
  default     = null
}

variable "auto_update" {
  description = "Systemd timer in the CT that pulls new images of auto_update_services and redeploys if they changed."
  type        = bool
  default     = true
}

variable "auto_update_interval" {
  description = "systemd time span between image checks."
  type        = string
  default     = "15min"
}

variable "auto_update_services" {
  description = "Services whose images we publish. Never put databases here: unattended major upgrades break data dirs."
  type        = list(string)
  default     = []
}

variable "public_hostnames" {
  description = "Public hostname => local URL in the CT (e.g. http://localhost:8080). Only printed, for the tunnel config."
  type        = map(string)
  default     = {}
}

variable "cloudflare_tunnel_token" {
  description = "Token of this project's own remotely-managed Cloudflare Tunnel, run inside the CT. Null = no tunnel."
  type        = string
  default     = null
  sensitive   = true

  validation {
    # An unfilled `cloudflare_tunnel_token = ""` from the example would start a connector without a token.
    condition     = var.cloudflare_tunnel_token == null || length(trimspace(coalesce(var.cloudflare_tunnel_token, " "))) > 20
    error_message = "cloudflare_tunnel_token is empty or too short: paste this project's tunnel token, or remove the line for no tunnel."
  }
}

###############################################################################
# Application env (.env)
###############################################################################

variable "env_file" {
  description = "Optional path to an existing .env (outside the repo). Overrides generated secrets; app_env overrides it."
  type        = string
  default     = null
}

variable "app_env" {
  description = "Application variables. Highest precedence (after IMAGE_TAG / COMPOSE_PROFILES)."
  type        = map(string)
  default     = {}
  sensitive   = true

  validation {
    condition     = alltrue([for v in values(var.app_env) : !strcontains(v, "\n")])
    error_message = "app_env values cannot contain newlines."
  }
}

variable "generated_secrets" {
  description = "Secrets Terraform generates if not supplied: { KEY = length }. Alphanumeric. Stored in the state."
  type        = map(number)
  default     = {}
}

variable "required_env_keys" {
  description = "Keys the app refuses to start without. The plan fails, listing them, if one is missing or empty."
  type        = list(string)
  default     = []
}

variable "strong_secret_keys" {
  description = "Keys whose supplied value must be at least min_secret_length characters."
  type        = list(string)
  default     = []
}

variable "min_secret_length" {
  type    = number
  default = 16
}

variable "placeholder_values" {
  description = "Values (case-insensitive) that mean 'not filled in', e.g. copied from .env.example."
  type        = list(string)
  default     = ["SECRET", "CHANGEME", "TODO", "XXX"]
}
