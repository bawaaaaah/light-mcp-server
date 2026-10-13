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
- **Télécharger et recharger depuis l'UI**, avec un aperçu des différences avant d'appliquer.
- **Jamais dedans** : secrets, config machine, données de plugins privés (seulement l'indication « nécessite le plugin X »).

## Versions et sécurité des données
- `schemaVersion` sur chaque manifeste. Les migrations sont versionnées et testées.
- Backup automatique avant chaque migration et à intervalles réguliers, avec rotation.
- **Mode hybride** : une régénération (import, IA, script) conserve ce qui a été ajusté à la main. Toute perte potentielle **bloque l'écriture** et est listée.

## CLI `light` (headless)
| Commande | Rôle |
|---|---|
| `light serve` | lance le serveur |
| `light import qxw <fichier>` | import et reconstruction d'un workspace QLC+ (proposition, puis `--apply`) |
| `light check` | lint hors ligne : schémas, règles, conflits de notes, contraste, symétrie, sections inertes |
| `light selftest` | auto-test de bout en bout contre un serveur qui tourne : MIDI injecté, DMX relu, cadence, exclusivité |
| `light export ableton` | MIDI Effect Rack (depuis la coquille), table des notes, `.mid` |
| `light export liveset <als>` | pose la setlist dans un Live Set (Live fermé, avec backup) |
| `light export cuesheet` / `board` | feuille de conduite, planche |
| `light pack` / `light unpack` | dossier vers `.lightshow`, et l'inverse |
| `light osc-table` | table des adresses OSC |

Chaque commande d'écriture accepte `--check` (n'écrit rien) et est idempotente.

## SDK de scripts
- **TypeScript** : un paquet `sdk/` qui expose les types (schémas zod) et un client des commandes (HTTP/WS).
- **Python et autres langages** : l'**API HTTP** documentée (OpenAPI générée depuis les schémas).
- Un générateur utilisateur écrit **à travers les commandes** du serveur ou produit des fichiers au format dossier, puis `light check` valide. Il ne contourne jamais la couche de commandes pour un serveur en marche.

## Tests
- Sérialisation aller-retour de tous les objets, ordre stable, idempotence (deux passes, aucun diff).
- `pack` puis `unpack` à l'identique, secrets absents.
- Migrations sur des fixtures de versions anciennes.
- CLI en `--check` sans écriture.
