# Système de plugins (extensions)

Objectif : **étendre** le serveur, l'UI et le MCP **sans modifier le cœur**. Le dépôt est **public** : tout ce qui est personnel (connecteurs, base de connaissances, contenus) passe par des plugins ou dossiers **privés**, hors du dépôt.

## Base
- Un plugin est un `McpPlugin` (modèle wing : `id, name, start, stop, getHealth, registerTools, registerHttpRoutes?, liveTopics?, getConfigSchema, getConfig, setConfig`), complété par des **points de contribution lumière**.
- Le plugin `light` est lui-même construit sur ces points de contribution. L'API est donc éprouvée par le cœur.
- **Un plugin réutilise les commandes, sélecteurs et composants existants** : il n'en recopie pas.

## Points de contribution
| Point | Apport | Exemple |
|---|---|---|
| `commands` | nouvelles actions (boutons, MIDI, OSC, timeline, MCP) | relais de machine à fumée |
| `mcp.tools/resources/prompts` | outils `ext_<id>_*`, rattachés à un profil | outils d'un connecteur |
| `connectors.input` / `output` | entrées d'événements, sorties supplémentaires | webhook, Philips Hue, KiNET |
| `songSources` | structures de chants génériques (titre, BPM, signature, sections, setlists) | catalogue de chants personnel (privé) |
| `tempoSources` | sources de BPM | OS2L, Ableton Link, analyse audio |
| `knowledge` | base de connaissances couleur | la table sentiments → couleurs de l'utilisateur (privée) |
| `fixtureProviders`, `importers`, `exporters` | bibliothèques et formats | autre logiciel lumière |
| `techniques`, `effects` | techniques à pas, formes d'onde, motifs | nouveau motif pixel |
| `rules` | types de contraintes | règle propre à un lieu |
| `ui` | widgets, pages, réglages, modèles de dashboard | widget du connecteur |
| `ws.topics`, `http.routes` | `ext:<id>:*`, `/api/ext/<id>/*` | — |

**Plugins prévus plus tard** : connecteur AbleSet, analyse et synchronisation audio, Ableton Link, OS2L.

## Configuration
- Un schéma zod, converti en JSON Schema, et un **formulaire généré** dans Réglages → Plugins.
- La configuration vit dans la couche machine. Les **secrets** sont stockés à part, ne sont jamais exportés dans un `.lightshow` et sont masqués dans l'UI.
- Activation et désactivation à chaud.

## Interface web
- Les modules UI sont servis par `/ext/<id>/ui.js` et chargés par `import()`.
- Un **SDK UI** donne accès au client WS, aux composants (fader, bouton, color picker), au thème et à l'i18n.
- Les widgets de plugin apparaissent dans la palette des dashboards. Le chargement en iframe sandboxée viendra plus tard.

## Chargement
- **Emplacements** :
  - `data/plugins/<id>/` (exclu de git : c'est là que vont les plugins privés) ;
  - paquet npm déclaré dans la config ;
  - chemin local.
- **Manifeste** `light-plugin.json` : `id`, `name`, `version`, `apiVersion` (semver, avec contrôle de compatibilité), `entry`, `ui?`, `permissions`.
- **Permissions déclarées** (réseau, commandes, écriture du show, outils MCP), affichées à l'activation. En v1, c'est une confiance déclarative dans le process ; l'isolation en `worker_thread` viendra plus tard.
- **Robustesse** : une exception désactive le plugin et le signale dans `getHealth()`. Le moteur et la sortie DMX ne sont jamais touchés.

## Confidentialité
- Les plugins privés, leur configuration et leurs données n'apparaissent **jamais** dans le dépôt, la doc, les exemples ou les exports partagés.
- Un export indique seulement « nécessite le plugin `<id>` » et dégrade proprement s'il est absent.
- Les références externes sont des identifiants opaques.

## MCP
`light_plugins_list` et `light_plugin_config_get/set` (secrets exclus). `light_song_from_structure({ source: "<plugin>", ref })`.

## Tests
- Plugin de démonstration neutre (`examples/plugin-hello`) : une commande, un outil MCP, un widget et un formulaire de config.
- Compatibilité d'`apiVersion`, plugin qui plante sans effet sur le moteur, activation à chaud, secrets absents des exports.
