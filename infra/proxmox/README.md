# infra/proxmox

Terraform that deploys this project into an unprivileged LXC on Proxmox VE (Docker Compose, Cloudflare
Tunnel, no inbound port).

```bash
cp terraform.tfvars.example terraform.tfvars   # fill it in
export TF_VAR_proxmox_api_token=… TF_VAR_cloudflare_tunnel_token=…
terraform init && terraform plan -out tfplan && terraform apply tfplan
terraform test                                 # offline checks, Proxmox provider mocked
terraform output ops                           # status / logs / update / shell commands
```

| File                        | Role                                                                  |
| --------------------------- | --------------------------------------------------------------------- |
| `bks.tf`                    | spécifique à bks : variables de l'app, `config.toml` rendu, port admin |
| `host.tf`                   | project pool, CT template (bridge and storage are shared, referenced) |
| `container.tf`              | the LXC and its optional vzdump job                                   |
| `env.tf`                    | generated secrets + the `.env` pushed into the CT, validation         |
| `deploy.tf`                 | ships the bundle over SSH (`pct push`) and runs `<app>ctl deploy`     |
| `files/compose.proxmox.yml` | Compose override for the LXC (loopback ports, restart, tunnel)        |
| `files/appctl.sh`           | in-CT helper: install Docker, deploy, update, status, logs            |
| `files/push.sh`             | host-side script run by `deploy.tf`                                   |

Procédure complète (bascule depuis l'instance locale, opérations, sauvegardes) :
[docs/deployment/proxmox.md](../../docs/deployment/proxmox.md).

The Terraform state contains every secret in clear: keep it local (gitignored) or on an encrypted backend.
