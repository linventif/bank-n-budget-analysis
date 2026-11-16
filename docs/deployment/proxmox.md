# Déploiement sur Proxmox

bks tourne dans un conteneur LXC non privilégié sur `pve-colloc`, avec Docker Compose. Il n'y a aucun port
entrant : l'accès public passe par un tunnel Cloudflare qui se connecte *depuis* le conteneur.

```text
pve-colloc
└── CT 111  bks  10.10.10.21  (non privilégié, nesting + keyctl, sur vmbr1 = NAT)
    ├── /var/lib/docker sur son propre volume (images + volume bks-data = la base), inclus dans vzdump
    ├── /opt/bks/{compose.yml, compose.proxmox.yml, .env, cloudflared.env, config.toml, eb.pem}
    ├── /usr/local/bin/bksctl, bks-update.timer (nouvelle image toutes les 15 min), bks-admin-filter.service
    └── projet compose bks :
          cloudflared (réseau hôte) ─▶ 127.0.0.1:9889 ─▶ bks (public : /terms /privacy /callback + tableau de bord par passkey)
          hôte Proxmox 10.10.10.1 ─▶ 10.10.10.21:9890 ─▶ bks (interface locale, sans authentification)
```

- **Image** : `ghcr.io/linventif/bank-n-budget-analysis`, publiée par la CI à chaque push sur `main`
  (`latest` et `sha-<commit>`). Rien n'est compilé sur le serveur.
- **Configuration** : `config.toml` est généré par Terraform (`infra/proxmox/bks.tf`) depuis
  `terraform.tfvars`. La clé Enable Banking est copiée depuis `eb_private_key_file`. Les deux fichiers sont
  montés en lecture seule, lisibles uniquement par l'utilisateur de l'image (uid 10001).
- **Interface locale (9890)** : publiée sur l'IP du conteneur, mais une règle `DOCKER-USER` n'accepte que
  l'hôte Proxmox. Le déploiement échoue si la règle ne peut pas être posée. On y accède par un tunnel SSH.
- **IA** : désactivée (`ai = null`). Règles, mémoire et classement manuel continuent de marcher.

## Prérequis

- Terraform ≥ 1.7 (déjà installé : `~/.local/bin/terraform`).
- Accès SSH au nœud, à laisser tourner :
  `cloudflared access tcp --hostname pve-colloc.linv.dev/ssh --url 127.0.0.1:2222`, avec la clé chargée
  dans l'agent (`ssh-add -l`).
- Le jeton d'API Proxmox : déjà exporté par `~/.zshenv` (`TF_VAR_proxmox_api_token`).
- Un **nouveau tunnel Cloudflare** réservé à ce conteneur (Zero Trust › Networks › Tunnels › Create,
  type cloudflared). Ne pas réutiliser celui de la machine actuelle : deux connecteurs se partageraient les
  requêtes. Son jeton va dans `terraform.tfvars` (`cloudflare_tunnel_token`), **pas** en variable
  d'environnement : `~/.zshenv` exporte déjà un `TF_VAR_cloudflare_tunnel_token` qui est celui d'un autre
  projet, et le fichier tfvars est prioritaire. Laissé vide, le plan échoue.
- La clé `.pem` Enable Banking, hors du dépôt.

## Premier déploiement et bascule

L'instance actuelle continue de tourner jusqu'à l'étape 4 : le nouveau conteneur démarre avec une base vide,
sans nom public.

**1. Publier l'image.** Pousser sur `main` et attendre la CI (job `image`). Vérifier que le paquet est
public (GitHub › Packages › bank-n-budget-analysis › visibilité) : `docker pull` doit marcher sans compte.

**2. Créer le conteneur.**

```bash
cd infra/proxmox
cp terraform.tfvars.example terraform.tfvars      # remplir : vm_id/IP libres, eb_app_id, eb_private_key_file…
terraform init
terraform plan -out tfplan                        # relire : uniquement des créations
terraform apply tfplan
terraform output ops
```

**3. Vérifier** : `ssh -p 2222 root@127.0.0.1 pct exec 111 -- bksctl status` (bks `running`, cloudflared
connecté) et `… bksctl admin-filter status` (règle `DROP` sur 9890).

**4. Migrer la base** (coupure de quelques minutes) :

```bash
# a. arrêter l'instance locale (plus aucune écriture), puis copier la base proprement (journal WAL inclus)
python3 -c "import sqlite3; sqlite3.connect('file:data/bank.db?mode=ro', uri=True).backup(sqlite3.connect('/tmp/bks-import.db'))"
# b. l'envoyer sur l'hôte, puis dans le conteneur (bksctl remplace la base et redémarre bks)
scp -P 2222 /tmp/bks-import.db root@127.0.0.1:/root/bks-import.db && rm /tmp/bks-import.db
ssh -p 2222 root@127.0.0.1 'pct push 111 /root/bks-import.db /root/bks-import.db --perms 0600 && rm /root/bks-import.db && pct exec 111 -- bksctl import-db /root/bks-import.db'
# (même commande dans : terraform output ops → import_db)
```

**5. Déplacer le nom public.** Dans Cloudflare, retirer `bks.example.com` des noms publics de l'ancien tunnel,
puis l'ajouter au nouveau : service `http://localhost:9889`. Arrêter ensuite le connecteur `cloudflared` de
la machine locale.

**6. Contrôler** : connexion par passkey sur <https://bks.example.com>, puis une synchronisation. Le nom d'hôte
n'a pas changé : les passkeys et l'URL de retour Enable Banking restent valides.

## Au quotidien

Toutes les commandes passent par l'hôte (`terraform output ops` les affiche avec les vraies valeurs) :

| Je veux…                        | Faire                                                                                   |
| ------------------------------- | --------------------------------------------------------------------------------------- |
| voir l'état                     | `ssh -p 2222 root@127.0.0.1 pct exec 111 -- bksctl status`                              |
| suivre les journaux             | `ssh -t -p 2222 root@127.0.0.1 pct exec 111 -- bksctl logs bks`                         |
| ouvrir l'interface locale       | `ssh -N -p 2222 -L 9890:10.10.10.21:9890 root@127.0.0.1`, puis <http://localhost:9890>  |
| ajouter une passkey             | interface locale › Appareils › lien d'ajout                                             |
| déployer une nouvelle version   | rien : push sur `main`, la CI publie, le minuteur tire l'image (ou `bksctl update`)     |
| épingler / revenir en arrière   | `image_tag = "sha-<commit>"` dans `terraform.tfvars`, `terraform apply`                 |
| changer la configuration        | modifier `terraform.tfvars`, `terraform apply` (config.toml réécrit, bks recréé)        |
| changer de clé Enable Banking   | nouveau fichier dans `eb_private_key_file` (+ `eb_app_id`), `terraform apply`           |
| réimporter une base             | étape 4 ci-dessus (l'ancienne est gardée en `bank.db.before-import`)                    |
| shell dans le conteneur         | `ssh -t -p 2222 root@127.0.0.1 pct enter 111`                                           |
| tout redéployer                 | `terraform apply -replace=terraform_data.deploy`                                        |

## Sauvegardes

Après la bascule, la base n'existe **plus que dans le conteneur** (volume Docker `bks_bks-data` sur
`/var/lib/docker`). Activer `backup_storage` (vzdump nocturne, volume Docker inclus). La sauvegarde reste
sur le nœud si le stockage est local : en garder aussi une copie ailleurs, par exemple avec la même
commande que l'étape 4, dans l'autre sens.

## Sécurité

- L'état Terraform contient en clair la configuration, la clé Enable Banking et les jetons. Il reste local
  (gitignoré) ; un backend distant devrait chiffrer et restreindre l'accès.
- `protection = true` (par défaut) : Proxmox refuse de supprimer le conteneur et ses disques, y compris lors
  d'un remplacement. Passer à `false` volontairement, `apply`, puis `destroy`.
- Ne jamais router 9890 dans le tunnel : l'interface locale n'a pas d'authentification.

## Dépannage

| Symptôme                                         | Piste                                                                                       |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `bks` redémarre en boucle                        | `bksctl logs bks` : config refusée, clé `.pem` invalide (« clé privée RSA invalide »)…       |
| 502 / 1033 sur bks.example.com                      | tunnel : `bksctl logs cloudflared`, nom public → `http://localhost:9889`                     |
| « Host non autorisé » sur l'interface locale     | ouvrir `http://localhost:9890` (le port local doit être 9890)                               |
| 9890 injoignable par le tunnel SSH               | `bksctl admin-filter status`, `admin_access = true`, bonne IP dans la commande `-L`          |
| `apply` échoue sur « admin port filter not in place » | iptables indisponible dans le conteneur : `pct exec 111 -- iptables -S DOCKER-USER`       |
| `pull` refusé (denied)                           | paquet GHCR encore privé : le rendre public                                                 |
