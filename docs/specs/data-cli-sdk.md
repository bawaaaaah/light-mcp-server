# Données, CLI et SDK

L'utilisateur travaille aujourd'hui avec des **générateurs, un `make` et git**, de façon idempotente et diff-able. Le nouvel outil garde cette possibilité.

## Trois couches
| Couche | Contenu | Emplacement |
|---|---|---|
| Machine | interfaces, IP, profils d'entrées MIDI, transports MCP, rôles et PIN, config et secrets des plugins | `data/machine/` |
| Lieu | fixtures, patch, scène, canevas et rendu, règles du lieu | `data/venues/<id>/` |
| Show | looks, techniques, palettes, presets, groupes, chants, setlists, mappings MIDI/OSC, registre de notes, dashboards, notes | `data/shows/<id>/` |

`data/` est **entièrement exclu de git**. Seuls des exemples neutres sont versionnés, dans `examples/`.

## Format sur disque : un dossier de fichiers texte
```
data/shows/<id>/
  show.json                 # manifeste : schemaVersion, lieu référencé, métadonnées
  palettes/<id>.json
  techniques/<id>.json
  looks/<id>.json
  groups/<id>.json
  songs/<id>.json
  setlists/<id>.json
  midi/mappings.json
  midi/notes-registry.json
  osc/addresses.json
  dashboards/<id>.json
  notes/<id>.json
```
- **Un fichier par objet**, clés triées, indentation fixe, identifiants stables : un diff git montre exactement ce qui a changé.
- **Idempotence** : deux sauvegardes ou deux générations successives ne produisent aucun diff.
- Le lieu suit la même logique (`venue.json`, `fixtures/`, `patch.json`, `stage.json`, `canvases/`, `rules.json`).

## Archive `.lightshow`
- Un **zip** du dossier du show, et éventuellement du lieu, avec un manifeste (versions, plugins requis, empreintes). Comme un `.docx` ou un `.als`.
- **Télécharger et recharger depuis l'UI**, avec un aperçu des différences avant d'appliquer (v1 : `POST /archive?dryRun=1`, fichiers ajoutés, modifiés, supprimés, comparés par contenu JSON et non par mise en forme ; « rien à restaurer » si identique ; `light unpack --check` en ligne de commande).
- **Jamais dedans** : secrets, config machine, données de plugins privés (seulement l'indication « nécessite le plugin X »).

## Versions et sécurité des données
- `schemaVersion` sur chaque manifeste. Les migrations sont versionnées et testées.
- Backup automatique avant chaque migration et à intervalles réguliers, avec rotation.
- **Mode hybride** : une régénération (import, IA, script) conserve ce qui a été ajusté à la main. Toute perte potentielle **bloque l'écriture** et est listée.

## Reprise après redémarrage (v1)
- Ce qui joue (looks, Blackout, setlist, chant, section) est écrit environ une fois par seconde dans `data/machine/live.json` (écriture atomique ; horodatage rafraîchi au moins toutes les 30 s).
- Au démarrage, il est **restauré seulement s'il a moins de 5 minutes** et concerne le même show : un plantage ou un redémarrage rapide pendant un culte reprend où on en était ; un démarrage le lendemain ne rallume rien par surprise.
- Les niveaux des groupes et le grand master sont déjà enregistrés dans le show ; les positions manuelles des lyres et les forçages de la console ne sont pas repris (volontairement).

## CLI `light` (headless, v1)
Adaptateur mince sur la couche de commandes. **Serveur en marche** : la CLI passe par son API HTTP avec le jeton maître ; **serveur injoignable** : elle ouvre directement les dossiers de données (jamais les deux à la fois, donc jamais deux écrivains sur un show). `--offline` force le second mode, `--url` choisit le serveur ; `LIGHT_CONFIG_PATH` et `LIGHT_DATA_ROOT` valent pour le serveur et la CLI.

| Commande | Rôle |
|---|---|
| `light serve [--standby \| --live]` | lance le serveur (en veille : n'envoie rien, voir [bascule](../bascule-qlc.md)) |
| `light token` / `pin <rôle> <pin>` / `roles` | jeton maître, PIN des rôles |
| `light check` | lint du show (schémas, conflits de notes, contraste, sections inertes) ; sortie 1 en cas d'erreur |
| `light selftest [--cadence]` | auto-test : mappings, exclusivité, latence, cadence mesurée ; sortie 1 en cas d'échec |
| `light import qxw <fichier> [--apply]` | import d'un workspace QLC+ : proposition, puis `--apply` pour écrire |
| `light export cuesheet [--setlist id]` / `notes [--csv]` / `board [--song id]` | feuille de conduite, table des notes, planche SVG d'un chant |
| `light export ableton [--shell f]` | MIDI Effect Rack depuis la coquille |
| `light export liveset --setlist id --als f --track nom` | pose la setlist dans une copie du Live Set (Live fermé) |
| `light pack [fichier] [--no-venue]` / `light unpack <fichier>` | sauvegarde `.lightshow`, restauration avec copie de l'existant |
| `light standby on\|off` | sortie en veille, reprendre la main |
| `light osc-table` | adresses OSC |
| `light call <commande> [json]` / `light commands` | n'importe quelle commande du registre, liste des commandes |

Plus tard : `--check` généralisé aux commandes d'écriture.

## SDK de scripts (v1)
Voir [`sdk/README.md`](../../sdk/README.md). Fait : client TypeScript `sdk/index.ts` (commandes, état, sauvegardes, sujets en direct par WebSocket, types du show), client Python `sdk/python/light_client.py` (bibliothèque standard, banc d'auto-test en ligne de commande), description **OpenAPI 3** générée depuis le registre (`GET /api/plugins/light/openapi.json`, validée avec Redocly). Reste : paquet npm publié.

- **TypeScript** : un paquet `sdk/` qui expose les types (schémas zod) et un client des commandes (HTTP/WS).
- **Python et autres langages** : l'**API HTTP** documentée (OpenAPI générée depuis les schémas).
- Un générateur utilisateur écrit **à travers les commandes** du serveur ou produit des fichiers au format dossier, puis `light check` valide. Il ne contourne jamais la couche de commandes pour un serveur en marche.

## Tests
- Sérialisation aller-retour de tous les objets, ordre stable, idempotence (deux passes, aucun diff).
- `pack` puis `unpack` à l'identique, secrets absents.
- Migrations sur des fixtures de versions anciennes.
- CLI en `--check` sans écriture.
