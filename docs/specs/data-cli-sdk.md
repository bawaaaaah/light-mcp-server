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

## Shows et sauvegardes (v1, comme une console lumière)
- Un show est un dossier `data/shows/<id>` ; son `show.json` porte son nom et le lieu sur lequel il joue (`data/venues/<id>`). Tout est enregistré au fil des modifications : il n'y a pas de bouton « Enregistrer ».
- **Ouvrir** un show se fait à chaud (`show.open`) : ce qui joue s'arrête, ses looks, chants, dashboards et mappings remplacent les précédents, sur tous les écrans (l'interface se recharge quand le show ouvert change). Le show ouvert est gardé dans la config machine.
- **Nouveau** (`show.create`) : vide, ou **copie** d'un autre (`from`, c'est « Enregistrer sous » et « Dupliquer »), sur le même lieu (même patch), une copie du lieu, ou un lieu vide ; ouvert aussitôt.
- **Renommer** (le dossier garde son identifiant), **supprimer** (un show fermé seulement, déplacé dans `data/backups/deleted/`, récupérable à la main).
- **Réinitialiser** (`show.reset`, administrateur) : vide le show ouvert, et sur demande son lieu, après une sauvegarde automatique.
- **Sauvegardes** : archives `.lightshow` du show ouvert et de son lieu gardées dans `data/backups/` (nom : show, date et heure locales, libellé), listées, restaurées (avec copie de l'existant) ou téléchargées depuis l'interface (page **Fichiers**).
- **Sauvegardes automatiques** (`data/retention.ts`) : au plus une par jour et par show (`<show>-<date>-auto.lightshow`), quand le show ou son lieu a changé depuis la précédente, ou s'il n'en a encore aucune ; première vérification 5 minutes après le démarrage, puis toutes les heures. Les **14** plus récentes sont gardées ; les sauvegardes faites à la main (même libellées « auto ») et celles d'avant une réinitialisation ou une restauration ne sont jamais supprimées. Marquées « auto » dans **Fichiers**.
- **Historique par objet** : chaque modification (et chaque suppression) garde une copie de l'objet dans `data/backups/shows|venues/<id>/<horodatage>/`. **Versions précédentes** : `history.list` et `history.restore` les relisent et en remettent une pour les looks, groupes, faders de canaux et dashboards (même un objet supprimé), en passant par la commande `*.put` habituelle et ses contrôles ; la version courante part à son tour dans l'historique (une restauration s'annule de la même façon), et le niveau en direct d'un DCA ou d'un fader ne bouge pas. `history.deleted` liste les objets supprimés que l'historique garde encore. **Annuler une modification** (`history.undo`, v1) : depuis une ligne du journal d'activité (bouton ↶ dans Réglages, ou un client IA avec `undo`, `at` et `until` de la ligne), l'objet revient à la version que cette modification a remplacée, et un objet supprimé revient ; ce qui a été changé dessus depuis est annulé aussi, et l'interface le dit avant, avec qui et quand. Une création n'a rien remplacé : elle s'annule en supprimant l'objet. Un niveau bougé (DCA, fader) est un état, pas une modification à annuler. Dans l'interface : « Versions précédentes » au pied des éditeurs de look, de groupe et de fader, et du dashboard en mode édition ; « Récemment supprimés » en bas de la page Show (looks, groupes, faders) et en mode édition des dashboards. Une copie n'est élaguée que si elle a **plus de 90 jours et** n'est pas parmi les **500** plus récentes de son show ou lieu.

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
| `light check` | lint du show (schémas, conflits de notes, contraste, sections inertes, chevauchements d'adresses, définitions manquantes, noms ambigus) ; sortie 1 en cas d'erreur |
| `light selftest [--cadence]` | auto-test : mappings, exclusivité, latence, cadence mesurée ; sortie 1 en cas d'échec |
| `light import qxw <fichier> [--apply]` | import d'un workspace QLC+ : proposition, puis `--apply` pour écrire |
| `light export cuesheet [--setlist id]` / `notes [--csv]` / `board [--song id]` | feuille de conduite, table des notes, planche SVG d'un chant |
| `light export ableton [--shell f]` | MIDI Effect Rack depuis la coquille |
| `light export liveset --setlist id --als f --track nom` | pose la setlist dans une copie du Live Set (Live fermé) |
| `light show list` / `new <nom> [--from id] [--venue current\|copy\|new]` / `open <id>` / `rename <nom>` / `reset [--with-venue]` | shows de la machine (voir plus haut) |
| `light backup list` / `create [libellé]` / `restore <fichier>` | sauvegardes `.lightshow` gardées dans `data/backups/` |
| `light pack [fichier] [--no-venue]` / `light unpack <fichier>` | sauvegarde `.lightshow`, restauration avec copie de l'existant |
| `light standby on\|off` | sortie en veille, reprendre la main |
| `light osc-table` | adresses OSC |
| `light activity [--limit 30]` | activité récente, la plus ancienne d'abord : quand, qui, d'où, quoi, sur quel objet ; hors ligne, ce que la CLI change y figure aussi |
| `light call <commande> [json]` / `light commands` | n'importe quelle commande du registre, liste des commandes |

`light call <commande> <json> --check` (v1) : pour un enregistrement (`look.put`, `group.put`, `fader.put`, `dashboard.put`, `palette.put`, `stage.zone.put`, `rule.put`, `venue.fixture.put`, `venue.canvas.put`), ce qu'il changerait, champ par champ, sans rien écrire (`show.diff`) ; une autre commande est refusée plutôt qu'exécutée. Plus tard : `--check` pour les autres commandes d'écriture.

## SDK de scripts (v1)
Voir [`sdk/README.md`](../../sdk/README.md). Fait : client TypeScript `src/sdk/index.ts` (publié comme `@bawaaaaah/light-mcp-server/sdk`) (commandes, état, sauvegardes, sujets en direct par WebSocket, types du show), client Python `sdk/python/light_client.py` (bibliothèque standard, banc d'auto-test en ligne de commande), description **OpenAPI 3** générée depuis le registre (`GET /api/plugins/light/openapi.json`, validée avec Redocly). Paquet publié sur GitHub Packages à chaque version ([install-npm.md](../install-npm.md)).

- **TypeScript** : un paquet `sdk/` qui expose les types (schémas zod) et un client des commandes (HTTP/WS).
- **Python et autres langages** : l'**API HTTP** documentée (OpenAPI générée depuis les schémas).
- Un générateur utilisateur écrit **à travers les commandes** du serveur ou produit des fichiers au format dossier, puis `light check` valide. Il ne contourne jamais la couche de commandes pour un serveur en marche.

## Tests
- Sérialisation aller-retour de tous les objets, ordre stable, idempotence (deux passes, aucun diff).
- `pack` puis `unpack` à l'identique, secrets absents.
- Migrations sur des fixtures de versions anciennes.
- CLI en `--check` sans écriture.
