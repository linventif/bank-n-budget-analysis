# Consignes pour les agents

## Projet et documentation

- Lire `README.md` pour le développement et `docs/deployment/proxmox.md` avant toute opération de déploiement.
- L'application Rust et SolidJS est déployée avec Docker Compose dans un LXC Proxmox. La configuration Terraform est dans `infra/proxmox/`.
- La cible configurée est `pve-colloc`, CT `111`, IP `10.10.10.21/24`. Le domaine public est défini par `public_url` dans `infra/proxmox/terraform.tfvars` (non versionné). Vérifier que l'identifiant et l'IP sont toujours libres avant une première création.
- Le bridge `vmbr1`, le stockage `dir-gmi` et le template sont partagés avec d'autres projets : les référencer, sans les modifier ni les importer dans cet état Terraform. Ne pas intervenir sur gmod dans le cadre d'un déploiement de bks.
- La branche locale à la reprise est `master`, qui suit `origin/main`. Le workflow de publication est déclenché par les pushes sur `main` : vérifier la branche distante visée avant tout push.
- Des modifications locales de l'interface et du déploiement préexistent à cette reprise. Les préserver et vérifier le périmètre avant tout commit.

## Outils et accès existants

- Terraform est déjà installé : `~/.local/bin/terraform`, cible `~/terraform-test/bin/terraform` (version constatée à la reprise : 1.17.1). Si le PATH ne le trouve pas, utiliser ce chemin ; ne pas demander de réinstallation.
- `cloudflared` est disponible à `/usr/local/bin/cloudflared`.
- Le jeton Proxmox est défini dans `~/.zshenv` sous `TF_VAR_proxmox_api_token`. Certaines sessions ne le chargent pas : sourcer ce fichier dans le shell de la commande si nécessaire, sans en afficher le contenu ni redemander le jeton.
- Dans l'environnement Codex de cette reprise, le bac à sable masque les secrets et bloque les sockets des fournisseurs Terraform et de l'agent SSH. Utiliser le mécanisme d'escalade de l'outil pour les commandes concernées ; ne pas contourner le bac à sable ni confondre ces restrictions avec des identifiants manquants ou des fournisseurs cassés.
- `~/.zshenv` définit aussi `TF_VAR_cloudflare_tunnel_token` pour un AUTRE projet. Ne jamais l'utiliser pour bks. Après avoir sourcé ce fichier, supprimer cette variable de l'environnement de la commande (`unset TF_VAR_cloudflare_tunnel_token`).
- Le jeton du tunnel propre à bks doit être renseigné dans `infra/proxmox/terraform.tfvars`, à `cloudflare_tunnel_token`. Ne pas l'exporter. Une valeur vide doit faire échouer le plan ; ne pas contourner ce contrôle en la supprimant ou en mettant `null` pour le déploiement public.
- La clé SSH existante est `~/.ssh/id_ed25519` ; vérifier l'agent avec `ssh-add -l`. Ne pas afficher la clé privée ni la remplacer.
- Vérifier l'accès au nœud avec `ssh -o BatchMode=yes -o ConnectTimeout=10 -p 2222 root@127.0.0.1 true`. Si le tunnel est arrêté, relancer en arrière-plan `cloudflared access tcp --hostname pve-colloc.linv.dev/ssh --url 127.0.0.1:2222`, puis vérifier de nouveau. Ne pas lancer un second connecteur si le port est déjà occupé.

## Secrets et données

- `config.toml`, `infra/proxmox/terraform.tfvars`, les plans et états Terraform, les clés privées et les données bancaires restent hors de Git. Les plans et états peuvent contenir les secrets en clair : ne pas les afficher intégralement, les joindre ou les publier.
- Le domaine public réel de l'application reste dans les configurations privées. Utiliser `bks.example.com` dans la documentation, les commentaires, les exemples et les valeurs par défaut versionnés ; ne pas y recopier le domaine depuis les fichiers locaux.
- La configuration Enable Banking, l'email et les clés de marché existent déjà dans les fichiers locaux. Les vérifier sans afficher les secrets avant de demander des informations à l'utilisateur.
- La clé Enable Banking reste dans `~/.config/bank-analysis/`, hors du dépôt. Son chemin configuré est `eb_private_key_file`.
- Ne jamais lancer le binaire `bks`, `cargo run` ou le binaire de release sans une configuration de développement explicite : le démarrage peut migrer la vraie base `data/bank.db` et importer son budget.
- Pour lancer l'application en développement, utiliser `BKS_CONFIG=dev/config.toml` et la base `dev/bank.db`, conformément au README. Pour le frontend, utiliser `BKS_API=http://127.0.0.1:19890`.
- Pour copier une base SQLite en cours d'utilisation, employer l'API de sauvegarde SQLite ; ne pas utiliser une simple copie du fichier `.db`.

## Déploiement Terraform

- Commencer par `terraform fmt -check -recursive`, `terraform validate` et `terraform test` depuis `infra/proxmox/`. Les tests Terraform existants utilisent un fournisseur Proxmox simulé et ne doivent pas modifier l'infrastructure.
- Avant de publier, exécuter les vérifications du README (`cargo test`, `cargo clippy`, puis `pnpm build` dans `web/`).
- Publier l'image via la CI sur `main` et vérifier que le job `image` réussit et que l'image GHCR est récupérable sans authentification avant de lancer le déploiement.
- Générer un plan sauvegardé avec `terraform plan -input=false -out=tfplan`, puis le relire. Le premier déploiement doit uniquement créer les ressources de bks. N'exécuter `terraform apply tfplan` qu'après cette revue et conformément à l'autorisation de déploiement donnée dans la conversation.
- Conserver `protection = true`. Ne pas lancer de destruction, désactiver cette protection ou accepter un remplacement de conteneur pour contourner un problème.
- Conserver l'instance locale et son tunnel pendant les vérifications du nouveau conteneur. La migration de la base et la bascule du domaine suivent les étapes distinctes de `docs/deployment/proxmox.md`.
- Le tunnel public cible uniquement `http://localhost:9889`. Ne jamais exposer le port `9890` : cette interface sans authentification est réservée à l'administration via SSH et filtrée pour l'hôte Proxmox.
- Vérifier après déploiement l'état de bks et de cloudflared, le filtre du port d'administration et le job de sauvegarde avant la bascule.

## État constaté à la reprise

- Aucun état Terraform local n'a été trouvé dans `infra/proxmox/` ; l'initialisation des fournisseurs existe déjà.
- Les paramètres applicatifs, `backup_storage = "local"` et le jeton du tunnel dédié à bks sont renseignés dans le fichier tfvars local. Ne pas copier ces valeurs dans la documentation ou dans Git.
- Ce constat sert de point de départ : vérifier les fichiers, l'état Terraform et l'infrastructure avant d'agir, car ils peuvent avoir changé depuis cette reprise.
