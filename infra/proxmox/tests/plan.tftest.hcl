# terraform test — plan seulement, API Proxmox simulée : aucun appel au nœud, rien n'est créé.

mock_provider "proxmox" {}

variables {
  app_name          = "bks"
  proxmox_endpoint  = "https://pve.invalid:8006/"
  proxmox_api_token = "00000000-0000-0000-0000-000000000000"
  node_name         = "pve-test"
  ssh_host          = "127.0.0.1"
  datastore_id      = "local"
  bridge            = "vmbr1"
  bridge_address    = "10.10.10.1/24"
  vm_id             = 999
  ipv4_address      = "10.10.10.99/24"
  template_file_id  = "local:vztmpl/ubuntu-24.04-standard_24.04-2_amd64.tar.zst"
  compose_file      = "tests/fixtures/compose.yml"
  extra_files       = {}

  # terraform test charge aussi un terraform.tfvars local et les TF_VAR_* du shell : tout figer.
  cloudflare_tunnel_token = null
  env_file                = null
  image_tag               = "latest"
  compose_profiles        = []
  generated_secrets       = {}
  required_env_keys       = []
  strong_secret_keys      = []
  app_env                 = {}

  public_url              = "https://bks.example.org"
  public_dashboard        = true
  legal_contact_email     = "contact@example.org"
  eb_app_id               = "11111111-2222-3333-4444-555555555555"
  eb_private_key_file     = "tests/fixtures/eb.pem"
  eb_countries            = ["FR", "FI"]
  eb_consent_days         = 180
  eb_auto_sync_hours      = 8
  ai                      = null
  market_fred_key         = null
  market_alphavantage_key = null
  admin_access            = true
  auto_update_services    = ["bks"]
}

run "config_renders" {
  command = plan

  assert {
    condition     = strcontains(nonsensitive(local.bks_config), "public_url       = \"https://bks.example.org\"\n")
    error_message = "public_url absent du config.toml"
  }
  assert {
    condition     = strcontains(nonsensitive(local.bks_config), "public_addr      = \"0.0.0.0:9889\"") && strcontains(nonsensitive(local.bks_config), "local_addr       = \"0.0.0.0:9890\"")
    error_message = "le serveur doit écouter sur toutes les interfaces du conteneur"
  }
  assert {
    condition     = strcontains(nonsensitive(local.bks_config), "database         = \"/data/bank.db\"") && strcontains(nonsensitive(local.bks_config), "private_key     = \"/etc/bks/eb.pem\"")
    error_message = "chemins du conteneur incorrects"
  }
  assert {
    condition     = strcontains(nonsensitive(local.bks_config), "countries       = [\"FR\",\"FI\"]")
    error_message = "pays non rendus"
  }
  assert {
    condition     = strcontains(nonsensitive(local.bks_config), "[ai]\nenabled = false")
    error_message = "l'IA doit être désactivée explicitement (elle est active par défaut dans l'application)"
  }
  assert {
    condition     = !strcontains(nonsensitive(local.bks_config), "fred_key") && !strcontains(nonsensitive(local.bks_config), "alphavantage_key")
    error_message = "clés de marché absentes : ne rien écrire"
  }
  assert {
    condition     = strcontains(nonsensitive(local.bks_private_key), "BEGIN PRIVATE KEY")
    error_message = "clé privée non lue"
  }
  assert {
    condition     = strcontains(local.env_content, "ADMIN_BIND=10.10.10.99\n") && strcontains(local.env_content, "ADMIN_ALLOW=10.10.10.1\n")
    error_message = "port d'administration : IP du conteneur, filtrée sur l'hôte"
  }
  assert {
    condition     = strcontains(local.appctl, "APP=\"bks\"") && strcontains(local.appctl, "UPDATE_SERVICES=\"bks\"") && !strcontains(local.appctl, "__APP_NAME__")
    error_message = "appctl mal rendu"
  }
}

run "ai_market_and_tunnel" {
  command = plan

  variables {
    ai                      = { provider = "ollama", url = "http://10.10.10.30:11434", model = "qwen3:4b" }
    market_fred_key         = "fred-secret"
    cloudflare_tunnel_token = "fake-tunnel-token-for-tests-0000"
    admin_access            = false
  }

  assert {
    condition     = strcontains(nonsensitive(local.bks_config), "enabled  = true\nprovider = \"ollama\"\nurl      = \"http://10.10.10.30:11434\"")
    error_message = "configuration IA non rendue"
  }
  assert {
    condition     = strcontains(nonsensitive(local.bks_config), "fred_key = \"fred-secret\"")
    error_message = "clé FRED non rendue"
  }
  assert {
    condition     = !strcontains(local.env_content, "fake-tunnel-token-for-tests-0000") && !strcontains(nonsensitive(local.bks_config), "fake-tunnel-token-for-tests-0000")
    error_message = "le jeton du tunnel ne doit atteindre que cloudflared.env"
  }
  assert {
    condition     = strcontains(local.env_content, "COMPOSE_PROFILES=tunnel\n")
    error_message = "profil tunnel non activé"
  }
  assert {
    condition     = strcontains(local.env_content, "ADMIN_BIND=127.0.0.1\n")
    error_message = "admin_access = false : loopback seulement"
  }
}

run "empty_tunnel_token_fails" {
  command = plan

  variables {
    cloudflare_tunnel_token = ""
  }

  expect_failures = [var.cloudflare_tunnel_token]
}

run "bad_app_id_fails" {
  command = plan

  variables {
    eb_app_id = "pas-un-uuid"
  }

  expect_failures = [var.eb_app_id]
}

run "missing_key_file_fails" {
  command = plan

  variables {
    eb_private_key_file = "tests/fixtures/absent.pem"
  }

  expect_failures = [var.eb_private_key_file]
}

run "http_public_url_fails" {
  command = plan

  variables {
    public_url = "http://bks.example.org/"
  }

  expect_failures = [var.public_url]
}

run "ip_outside_bridge_subnet_fails" {
  command = plan

  variables {
    ipv4_address = "192.168.1.20/24"
  }

  expect_failures = [proxmox_virtual_environment_container.app]
}
