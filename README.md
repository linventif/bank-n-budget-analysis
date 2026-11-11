# bks

Suivi personnel de mes comptes bancaires via [Enable Banking](https://enablebanking.com)
(DSP2, mode restreint gratuit pour ses propres comptes), avec analyses budgétaires
et classement des dépenses par un modèle d'IA **local**.

## Architecture

```
Internet ── Cloudflare tunnel (bks.example.com) ──▶ 127.0.0.1:9889   /terms /privacy /callback
Navigateur local ───────────────────────────────▶ 127.0.0.1:9890   frontend Solid + /api (jamais exposé)
                                                      │
                          data/bank.db (SQLite, chmod 600)   vLLM 127.0.0.1:8000 (IA locale)
```

- **Backend** Rust (axum, rusqlite) — `src/`
- **Frontend** SolidJS + Tailwind v4 + daisyUI v5 + Iconify (Lucide embarqué) — `web/`
- Deux écoutes séparées : le tunnel ne voit que les pages publiques et le retour d'autorisation.
  L'interface privée vérifie `Host` (anti DNS-rebinding) et `Origin` sur les requêtes non-GET.

## Mise en route

```bash
cp config.example.toml config.toml        # puis remplir
(cd web && pnpm install && pnpm build)    # frontend → web/dist
cargo run --release                       # http://localhost:9890
```

IA locale (facultative, mais c'est elle qui classe les marchands inconnus) : vLLM sur CPU,
dans Docker, avec Qwen3-4B quantifié AWQ (~9 Go de RAM une fois chargé) :

```bash
./scripts/vllm.sh start     # 1er lancement : téléchargement du modèle, puis 2 à 4 min de chargement
./scripts/vllm.sh stop      # libère la mémoire quand on n'en a pas besoin
```

Le port 8000 n'est publié que sur 127.0.0.1. Tout autre serveur compatible OpenAI convient
(`[ai] provider = "vllm"`, `url = …/v1`), ainsi qu'Ollama (`provider = "ollama"`).

Développement du frontend avec rechargement à chaud : `cd web && pnpm dev` (<http://localhost:5173>,
l'API est relayée vers le serveur Rust sur 9890).

Côté Enable Banking (application **Production**) :

| Champ | Valeur |
|---|---|
| Allowed redirect URLs | `https://bks.example.com/callback` |
| Privacy URL | `https://bks.example.com/privacy` |
| Terms URL | `https://bks.example.com/terms` |

Ranger la clé privée hors du dépôt : `~/.config/bank-analysis/<app_id>.pem` (chmod 600),
puis « Activate by linking accounts » pour lier ses comptes. Une banque doit être autorisée
via le même pays que lors du linking (`countries = ["FR", "FI"]`).

## Catégorisation

Par ordre de priorité (une étape ne touche jamais ce qu'une étape plus prioritaire a décidé) :

1. **Manuel** — choix fait dans l'interface ; jamais modifié automatiquement.
2. **Règles** — « le libellé contient … » → catégorie (le motif le plus long gagne).
3. **Mémoire** — même marchand (libellé normalisé) qu'une opération classée à la main.
4. **Virements internes / épargne** — à son propre nom, paires débit/crédit entre ses comptes,
   poches et coffres Revolut.
5. **IA locale** — vLLM (ou Ollama), un appel par lot de marchands (pas par opération), sortie contrainte
   par un schéma JSON dont l'énumération ne contient que les catégories cohérentes avec le sens
   de l'opération. Les classements à confiance < 0,6 sont marqués « À vérifier ».

Les descriptions des catégories sont envoyées au modèle : les enrichir (enseignes, exemples)
améliore le classement.

## Budget

Onglet **Budget**, structuré comme un tableur : postes (lignes, groupés par section) × périodes
(colonnes, ex. « Toulouse » × 5 mois puis « Lille » × 4 mois), plus une colonne annuel / ponctuel.
Types de poste : dépense, aide / revenu (réduit le reste à charge), salaire, info (hors totaux).

- **Plan** : édition directe des montants ; totaux « dépenses − aides = reste à charge » et
  « salaire − reste à charge = disponible », par période et sur toute la durée.
- **Suivi** (budget dynamique) : pour un mois, prévu / réel / détecté (moyenne des 3 mois
  précédents) par poste. Un poste se rattache aux opérations par motif de libellé (prioritaire)
  ou par catégorie, dans le bon sens (dépense = débit). Hors budget et récurrents non budgétés
  peuvent être ajoutés en un clic ; « viser » aligne l'objectif sur le détecté.
- **Récurrents** : abonnements (montant fixe), dépenses et revenus réguliers ; cadence
  hebdomadaire, mensuelle, trimestrielle ou annuelle ; en retard / arrêtés.
- Création : vierge, depuis les dépenses détectées, ou copie. Le budget actif alimente le tableau de bord.
- Un `data/budget-seed.json` (hors dépôt) est importé une fois au démarrage, puis renommé.

## Analyses

Tableau de bord mensuel (dépenses vs moyenne à date, solde, taux d'épargne, rythme cumulé,
budgets, catégories, marchands, 12 mois, paiements récurrents), tendances par catégorie
(carte de chaleur), recherche et filtres sur les opérations.

## Flux bancaire

1. Comptes & IA → choisir la banque → `POST /auth` → page de la banque.
2. La banque renvoie vers `https://bks.example.com/callback?code=…&state=…`
   (`state` à usage unique, valable 1 h) → `POST /sessions` → comptes enregistrés.
3. Synchro immédiate (historique le plus long possible), puis à la demande :
   soldes + transactions depuis la dernière opération connue − 10 jours, puis catégorisation.

Le consentement expire (180 j max) : il suffit de relancer l'autorisation, les comptes
sont rattachés par `identification_hash`.
