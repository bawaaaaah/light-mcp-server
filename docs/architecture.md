# Architecture

## Principes
1. **Calquée sur [wing-mcp-server](https://github.com/bawaaaaah/wing-mcp-server)** : un cœur générique (`src/core` : config, event bus, hub WebSocket, passerelle MCP HTTP + stdio, extensions) et un plugin métier (`src/plugins/light`).
2. **Une seule couche de commandes.** UI web, MIDI, OSC, MCP, timeline des chants, CLI et SDK appellent **les mêmes commandes**. Chaque commande :
   - valide ses paramètres (zod) ;
   - vérifie les droits du rôle ;
   - modifie l'état et publie sur l'EventBus (topics WS, retour MIDI, journal) ;
   - s'inscrit à l'undo.
3. **Réutiliser avant d'écrire.** Toute nouvelle fonctionnalité réutilise les commandes, sélecteurs, utilitaires et schémas existants. Pas de duplication : c'est une règle explicite pour les agents qui implémentent.
4. **Le moteur ne dépend pas de l'UI.** La sortie DMX continue si l'UI, le WebSocket ou un plugin tombe. Un watchdog surveille le tick.

## Stack
Node ≥ 22.6, TypeScript ESM, Express 5, `ws`, `@msgpack/msgpack`, zod (+ `zod-to-json-schema`), `@modelcontextprotocol/sdk`, `@julusian/midi` (MIDI natif), une lib RTP-MIDI et une lib OSC. Tests avec Mocha + Chai, lint ESLint. Front en Vite + React + TypeScript, `react-grid-layout`, i18n FR/EN.

## Arborescence cible
```
src/
  index.ts                     # bootstrap(): machine config → EventBus → extensions → LightPlugin → McpRuntime
  cli/                         # CLI headless `light` (voir specs/data-cli-sdk.md)
  core/                        # générique (repris de wing)
    plugin.ts, config-store.ts, env.ts, event-bus.ts, health.ts, http-errors.ts
    auth/                      # rôles, PIN (v1), comptes et liens/QR (plus tard), tickets WS
    ws-hub.ts, ws-codec.ts, ws-rest.ts
    mcp-gateway-server.ts, mcp-runtime.ts, mcp-server-factory.ts, stdio-endpoint.ts, tool-catalogue.ts
    extensions/                # chargement des plugins (manifeste, apiVersion, permissions, secrets)
    i18n/                      # messages serveur et MCP FR/EN
  plugins/light/
    light-plugin.ts
    commands/                  # couche de commandes unique
    data/                      # stores machine / lieu / show, format dossier, archive .lightshow, migrations
    output/                    # artnet, artnet-discovery, sacn, output-router
    venue/                     # fixtures (schéma OFL, imports OFL/.qxf), patch, stage, canvas (canevas et rendu)
    engine/                    # dmx-engine, merger, programmer, attributes
    groups/                    # objet Groupe unifié (master, exclusif, limites, presets inclus ou exclus)
    rules/                     # règles et masque final
    functions/                 # looks, techniques (pas), effets (formes d'onde), cue stacks, collections, matrices
    timing/                    # easing, durées fixe/musicale, horloge tempo
    presets/                   # palettes, presets, presets automatiques, import et reconstruction .qxw
    songs/                     # chants, grille, timeline, setlist, exports conduite et planche
    midi/                      # hub, sources (local, Web MIDI, RTP), mapping, registre de notes, feedback, clock
    osc/                       # serveur OSC, table d'adresses, /light/help
    ableton/                   # export MIDI Effect Rack, générateur de Live Set
    dashboards/
    knowledge/                 # base de connaissances couleur (générique ; contenu privé via plugin)
    notes/
    selectors/, proposals/, preview/, describe/, log/, safety/, lint/, selftest/
    live-topics.ts, http-routes/, tools/   # tools = outils MCP
sdk/                           # SDK de scripts (TS) ; API HTTP documentée pour Python
web/
  src/ws/client.ts, src/i18n/, src/pages/, src/widgets/
test/
data/                          # EXCLU de git (machine, lieux, shows, plugins privés, secrets)
examples/                      # lieu et show d'exemple, neutres
docs/
```

## Données : trois couches
| Couche | Contenu | Emplacement |
|---|---|---|
| **Machine** | interfaces réseau, IP Art-Net, ports et profils d'entrées MIDI, transports MCP, rôles et PIN | `data/machine/` |
| **Lieu** | patch, fixtures, scène, canevas et rendu, règles du lieu | `data/venues/<id>/` |
| **Show** | looks, techniques, palettes, presets, chants, setlists, groupes, mappings MIDI/OSC, registre de notes, dashboards, notes | `data/shows/<id>/` |

- Un show **référence** un lieu et ne contient jamais d'IP ni de port.
- Plusieurs shows d'un même lieu partagent le patch : **aucun repatch**.
- Format : un **dossier de fichiers texte** (un fichier par objet, ordre de clés stable, diff-able dans git).
- Pour sauvegarder ou transporter : une **archive `.lightshow`**, téléchargeable et rechargeable dans l'UI.
- `schemaVersion`, migrations testées, backup avant chaque migration et rotation des sauvegardes.
- Détails : [specs/data-cli-sdk.md](specs/data-cli-sdk.md).

## Protocole WebSocket (repris de wing)
- Endpoint `/api/ws`, ticket via `POST /api/auth/ws-ticket` (30 s, usage unique). Le ticket porte le rôle.
- Sous-protocoles `light.control.v1.{msgpack|json}` et `light.stream.v1.{msgpack|json}`.
- Enveloppe `{t, id?, topic?, data?}` avec les types `hello | sub | unsub | ack | evt | req | res | err`. `req` et `res` relaient les routes REST, corrélées par `id`.

| Topic | Canal | Contenu |
|---|---|---|
| `light:state` | control | playbacks actifs, groupes et niveaux, blackout, freeze |
| `light:nodes` | control | nodes Art-Net et sACN détectés |
| `light:show` | control | modifications du show et du lieu |
| `light:dashboards` | control | dashboards, dashboard actif |
| `light:midi` | control | ports détectés, entrées surveillées, moniteur, learn |
| `light:tempo` | control | BPM, source, horloge reçue ou absente, phase |
| `light:song` | control | chant et section courants, position |
| `light:rules` | control | bornages appliqués et leur provenance |
| `light:conflicts` | control | conflits entre looks actifs |
| `light:auth` | control | session et rôle |
| `light:dmx` | stream | `params.universes`, 512 octets par univers, ≤ 25 Hz par client, envoyé seulement s'il y a un changement |
| `light:fx-preview` | stream | aperçu d'un effet en cours d'édition |

## Pipeline du moteur (tick ≈ 44 Hz, horloge injectable)
1. **Sources** : programmer (priorité max), puis playbacks actifs (looks, techniques, effets, cue stacks, matrices), puis valeurs par défaut.
2. **Fusion** : HTP pour l'intensité, LTP horodaté pour le reste, priorité par playback. Les effets sont absolus ou relatifs.
3. **Groupes** : masters proportionnels en cascade jusqu'au grand master, mute, flash, limites de groupe ([groups-masters](specs/groups-masters.md)).
4. **Blackout, freeze, flash.**
5. **Masque de règles** : max et plages, capabilities interdites, zones protégées, drapeaux de section ([rules-limits](specs/rules-limits.md)).
6. **Conversion attribut → DMX** selon le patch, puis buffers d'univers, puis `output-router`.

## Authentification et rôles
- **v1 : PIN par rôle.** L'admin crée les rôles et leurs droits : pages, dashboards, widgets, commandes. Rôles types : admin du lieu, régisseur, bénévole limité, lecture seule.
- Les droits s'appliquent à **l'UI, au WS, au MCP (token par rôle) et à l'OSC** (liste d'IP autorisées ou mot de passe).
- **Plus tard** : comptes nominatifs (mot de passe ou passkey, journal par personne) et liens ou QR secrets.

## Déploiement et dimensionnement
- **Référence v1 : natif sur le Mac de régie** (CoreMIDI, bus IAC, même machine qu'Ableton).
  - Une **app de barre de menus** (`macos/`, reprise de wing-mcp-server) lance `node dist/cli/main.js serve` comme enfant, le relance s'il plante et le recompile ; quitter l'app arrête le serveur.
- **Serveur distant** : Linux, Raspberry Pi (profil léger) et image Docker multi-arch, alimentés en **RTP-MIDI**.
  - Attention : Docker sur Mac ne voit ni CoreMIDI ni le bus IAC.
  - Attention : Web MIDI est absent de Safari et de l'iPad.
- **Dimensionnement** : 16 univers, 5 écrans ou plus.
- **Budgets** : MIDI → DMX < 10 ms ; aucune trame perdue ; stream DMX par univers et par client.

## Plugins
Voir [specs/plugins.md](specs/plugins.md). Le plugin `light` utilise lui-même les points de contribution. Les plugins privés vivent dans `data/plugins/`.

## Vérification (stratégie)
- Tests unitaires des codecs : ArtDmx, ArtPoll et ArtPollReply, E1.31, MIDI, OSC, enveloppe WS, `.adg`.
- Moteur déterministe (horloge injectée), faux node Art-Net en process, tests de migrations.
- **Selftest de bout en bout** : injection MIDI, relecture DMX, cadence, exclusivité. C'est le critère de la v0 ([roadmap](roadmap.md)).
- Tests manuels : vrai node ou Wireshark (filtre `artnet`), Ableton (clock, SPP, racks), MCP Inspector.
