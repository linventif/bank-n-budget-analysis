# bks

Suivi personnel de mes comptes bancaires via [Enable Banking](https://enablebanking.com)
(DSP2, mode restreint gratuit pour ses propres comptes).

## Architecture

```
Internet ── Cloudflare tunnel (bks.example.com) ──▶ 127.0.0.1:9889   /terms /privacy /callback
Navigateur local ───────────────────────────────▶ 127.0.0.1:9890   tableau de bord (jamais exposé)
                                                      │
                                     data/bank.db (SQLite, chmod 600)
```

Deux écoutes séparées : le tunnel ne voit que les pages publiques et le retour d'autorisation.
Le tableau de bord vérifie `Host` (anti DNS-rebinding) et `Origin` sur les POST.

## Mise en route

```bash
cp config.example.toml config.toml   # puis remplir
cargo run --release
```

Côté Enable Banking (application **Production**) :

| Champ | Valeur |
|---|---|
| Allowed redirect URLs | `https://bks.example.com/callback` |
| Privacy URL | `https://bks.example.com/privacy` |
| Terms URL | `https://bks.example.com/terms` |

Ranger la clé privée hors du dépôt : `~/.config/bank-analysis/<app_id>.pem` (chmod 600),
puis « Activate by linking accounts » pour lier ses comptes.

## Flux

1. Tableau de bord → « Autoriser l'accès » → `POST /auth` → page de la banque.
2. La banque renvoie vers `https://bks.example.com/callback?code=…&state=…`
   (`state` à usage unique, valable 1 h) → `POST /sessions` → comptes enregistrés.
3. Synchro immédiate (historique le plus long possible), puis à la demande :
   soldes + transactions depuis la dernière opération connue − 10 jours.

Le consentement expire (180 j max) : il suffit de relancer l'autorisation, les comptes
sont rattachés par `identification_hash`.
