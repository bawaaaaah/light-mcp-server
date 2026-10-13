# Consignes pour les agents

Lire d'abord [`docs/HANDOFF.md`](docs/HANDOFF.md), puis la spec concernée dans `docs/specs/`.

## Règles
- **Réutiliser avant d'écrire.** Chercher les commandes, codecs, utilitaires et schémas existants avant d'en créer un. Pas de duplication. Les outils MCP, les routes HTTP et OSC et la CLI sont de minces adaptateurs sur la couche de commandes.
- **Confidentialité (dépôt public).** Aucune donnée privée de l'utilisateur : pas de nom de lieu, d'événement, de chant ou de personne, pas d'IP, ni dans le code, ni dans la doc, ni dans les tests, les exemples ou les commits. Le privé vit dans `data/` (exclu de git). Faire un grep de contrôle avant chaque commit.
- **Décisions** : une nouvelle décision va dans `docs/decisions.md` **et** dans la spec concernée, jamais en annexe en fin de fichier.
- **Langue** : la doc et les échanges avec l'utilisateur sont en français ; le code, les identifiants et les commentaires en anglais.
- **Style** : TypeScript strict, ESM, Node ≥ 22.6. Les modules purs (codecs, calculs) sont séparés des entrées-sorties pour être testables sans matériel. Le temps est injectable.

## Commandes
```bash
npm test            # mocha + tsx
npm run typecheck
npm run proto:<nom> # prototypes de l'étape 0 (voir prototypes/README.md)
```
