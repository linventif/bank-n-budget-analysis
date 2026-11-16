# Ships the stack into the CT and runs `<app_name>ctl deploy`, over SSH to the Proxmox host
# (pct push / pct exec: the CT itself needs no SSH server nor inbound access).
#
# Re-runs whenever the CT is replaced or anything it ships changes. `docker compose up -d` then only
# recreates the services whose configuration changed. Force a redeploy with:
#   terraform apply -replace=terraform_data.deploy

locals {
  staging_dir = "/root/${var.app_name}-deploy-${var.vm_id}"

  appctl = replace(replace(replace(file("${path.module}/files/appctl.sh"),
    "__APP_NAME__", var.app_name),
    "__UPDATE_SERVICES__", join(" ", var.auto_update_services)),
  "__WAIT_SERVICE__", var.wait_service == null ? "" : var.wait_service)

  push_sh = file("${path.module}/files/push.sh")

  # Everything that lands in /opt/<app_name>, by path. Text files only (file() reads UTF-8).
  bundle = merge(
    { for dest, src in var.extra_files : dest => file("${path.module}/${src}") },
    {
      "compose.yml"         = file("${path.module}/${var.compose_file}")
      "compose.proxmox.yml" = file("${path.module}/files/compose.proxmox.yml")
    },
  )
  secrets = {
    ".env"            = local.env_content
    "cloudflared.env" = local.cloudflared_env
    # bks : configuration et clé Enable Banking, lisibles par l'utilisateur de l'image seulement (push.sh).
    "config.toml" = local.bks_config
    "eb.pem"      = local.bks_private_key
  }

  # A single script that recreates the whole bundle under ./payload on the host (base64: no quoting issue,
  # any number of files with one file provisioner). push.sh runs it, then tars payload/ into the CT.
  unpack_sh = join("", concat(["set -eu\n"], [
    for p, c in merge(local.bundle, local.secrets) :
    "mkdir -p \"payload/$(dirname '${p}')\"\nbase64 -d > 'payload/${p}' <<'__EOF__'\n${base64encode(c)}\n__EOF__\n"
  ]))
}

resource "terraform_data" "deploy" {
  triggers_replace = {
    container = proxmox_virtual_environment_container.app.id
    bundle    = sha256(jsonencode(local.bundle))
    scripts   = sha256("${local.appctl}${local.push_sh}")
    # Hashes of secrets: safe to show, and the plan says which part changed.
    env     = nonsensitive(sha256(local.env_content))
    tunnel  = nonsensitive(sha256(local.cloudflared_env))
    config  = nonsensitive(sha256(local.bks_config))
    key     = nonsensitive(sha256(local.bks_private_key))
    options = "auto_update=${var.auto_update} interval=${var.auto_update_interval}"
  }

  lifecycle {
    precondition {
      condition     = length(local.env_missing_keys) == 0
      error_message = "Missing or empty application variables (set them in app_env or env_file): ${join(", ", local.env_missing_keys)}"
    }
    precondition {
      condition     = length(local.env_placeholder_keys) == 0
      error_message = "Still set to a placeholder value (${join("/", var.placeholder_values)}): ${join(", ", local.env_placeholder_keys)}"
    }
    precondition {
      condition     = length(local.env_weak_keys) == 0
      error_message = "Shorter than ${var.min_secret_length} characters: ${join(", ", local.env_weak_keys)}"
    }
    # Project-specific checks go here, each with a test in tests/plan.tftest.hcl.
  }

  connection {
    type  = "ssh"
    host  = var.ssh_host
    port  = var.ssh_port
    user  = "root"
    agent = true
  }

  provisioner "remote-exec" {
    inline = ["rm -rf ${local.staging_dir} && install -d -m 0700 ${local.staging_dir}"]
  }

  provisioner "file" {
    content     = local.unpack_sh
    destination = "${local.staging_dir}/unpack.sh"
  }

  provisioner "file" {
    content     = local.appctl
    destination = "${local.staging_dir}/appctl.sh"
  }

  provisioner "file" {
    content     = local.push_sh
    destination = "${local.staging_dir}/push.sh"
  }

  # push.sh deletes the staging dir (it holds the .env) on exit, success or not.
  provisioner "remote-exec" {
    inline = [
      "BKS_UID=${local.bks_uid} bash ${local.staging_dir}/push.sh ${var.vm_id} ${local.staging_dir} ${var.app_name} --auto-update ${var.auto_update} --interval ${var.auto_update_interval}",
    ]
  }
}
