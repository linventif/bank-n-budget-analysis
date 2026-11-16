# Spécifique à bks : l'application lit un config.toml (pas de variables d'environnement) et une clé privée
# Enable Banking. Les deux sont rendus ici et poussés dans /opt/bks avec les autres secrets (deploy.tf),
# puis montés en lecture seule dans le conteneur (compose.yml).

variable "public_url" {
  description = "Adresse publique (tunnel). Les passkeys et l'URL de retour Enable Banking y sont liées : ne pas la changer à la légère."
  type        = string
  default     = "https://bks.example.com"

  validation {
    condition     = can(regex("^https://[a-z0-9.-]+$", var.public_url))
    error_message = "public_url : https://<nom d'hôte>, sans chemin ni barre finale."
  }
}

variable "public_dashboard" {
  description = "Tableau de bord servi aussi sur l'adresse publique, derrière une connexion par passkey."
  type        = bool
  default     = true
}

variable "legal_contact_email" {
  description = "Adresse affichée sur /terms et /privacy. Null = aucune."
  type        = string
  default     = null
}

variable "eb_app_id" {
  description = "Enable Banking : identifiant de l'application (UUID, = nom du fichier .pem)."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", var.eb_app_id))
    error_message = "eb_app_id doit être l'UUID de l'application Enable Banking."
  }
}

variable "eb_private_key_file" {
  description = "Chemin de la clé privée Enable Banking (.pem), hors du dépôt. Copiée dans le conteneur."
  type        = string

  validation {
    condition     = fileexists(var.eb_private_key_file) && strcontains(file(var.eb_private_key_file), "PRIVATE KEY-----")
    error_message = "eb_private_key_file : fichier introuvable ou qui n'est pas une clé privée PEM."
  }
}

variable "eb_countries" {
  description = "Pays dont les banques sont proposées (celui utilisé lors du linking de chaque banque)."
  type        = list(string)
  default     = ["FR"]
}

variable "eb_consent_days" {
  type    = number
  default = 180
}

variable "eb_auto_sync_hours" {
  description = "Synchronisation automatique toutes les N heures (0 = jamais)."
  type        = number
  default     = 8
}

variable "ai" {
  description = "Classement par IA : serveur compatible OpenAI (vllm) ou Ollama joignable depuis le conteneur. Null = désactivé."
  type = object({
    provider = string
    url      = string
    model    = string
  })
  default = null
}

variable "market_fred_key" {
  type      = string
  default   = null
  sensitive = true
}

variable "market_alphavantage_key" {
  type      = string
  default   = null
  sensitive = true
}

variable "admin_access" {
  description = <<-EOT
    Interface locale (9890, sans authentification, seule à gérer les passkeys) publiée sur l'IP du conteneur et
    filtrée pour n'accepter que l'hôte Proxmox (bridge_address). Accès : ssh -L 9890:<ip>:9890 vers l'hôte.
    false = loopback du conteneur uniquement.
  EOT
  type        = bool
  default     = true
}

locals {
  bks_uid = 10001 # utilisateur de l'image (Dockerfile)

  # TOML : jsonencode produit des chaînes et des tableaux valides en TOML.
  # Toujours sensible (clés de marché) : terraform plan n'en affiche que l'empreinte.
  bks_config = sensitive(join("\n", compact([
    "# Généré par Terraform (infra/proxmox/bks.tf). Modifier les variables Terraform, pas ce fichier.",
    "[server]",
    "public_url       = ${jsonencode(var.public_url)}",
    "public_addr      = \"0.0.0.0:9889\"",
    "local_addr       = \"0.0.0.0:9890\"",
    "database         = \"/data/bank.db\"",
    "web_dir          = \"/app/web/dist\"",
    "public_dashboard = ${var.public_dashboard}",
    "",
    "[legal]",
    var.legal_contact_email == null ? "" : "contact_email = ${jsonencode(var.legal_contact_email)}",
    "",
    "[enable_banking]",
    "app_id          = ${jsonencode(var.eb_app_id)}",
    "private_key     = \"/etc/bks/eb.pem\"",
    "countries       = ${jsonencode(var.eb_countries)}",
    "consent_days    = ${var.eb_consent_days}",
    "auto_sync_hours = ${var.eb_auto_sync_hours}",
    "",
    "[ai]",
    var.ai == null ? "enabled = false" : "enabled  = true\nprovider = ${jsonencode(var.ai.provider)}\nurl      = ${jsonencode(var.ai.url)}\nmodel    = ${jsonencode(var.ai.model)}",
    "",
    "[market]",
    var.market_fred_key == null ? "" : "fred_key = ${jsonencode(var.market_fred_key)}",
    var.market_alphavantage_key == null ? "" : "alphavantage_key = ${jsonencode(var.market_alphavantage_key)}",
  ])))

  bks_private_key = sensitive(file(var.eb_private_key_file))

  # Lu par compose.proxmox.yml (ports) et par bksctl (filtre du port d'administration).
  bks_env = {
    ADMIN_BIND  = var.admin_access ? local.container_ip : "127.0.0.1"
    ADMIN_ALLOW = local.gateway
  }
}
