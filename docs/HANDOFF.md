# HANDOFF — reprendre le projet

Point d'entrée pour un agent ou un humain qui reprend le projet. **À lire en premier.**

## Où on en est (2026-10-14)
- **v0 fonctionnellement complète côté logiciel**, en attente des tests matériel de l'utilisateur (fin de semaine).
- **Prototypes** : [research/proto-resultats.md](research/proto-resultats.md). Six validés ici ; P1/P4/P5 (Mac), P3/P8 (Live), P6 (réseau lumière) à faire par l'utilisateur.
- **Serveur** (`npm test` : 201 tests verts), avancement détaillé dans [roadmap.md](roadmap.md) :
  - registre de commandes unique → outils MCP, routes HTTP, adresses OSC ;
  - sortie Art-Net/sACN + découverte ;
  - lieu (patch, canevas, scène, zones protégées), show (palettes, looks, techniques dont ondes, groupes façon DCA), règles ;
  - lyres : pan/tilt 16 bits, Move FX dans les looks, position manuelle et « viser une zone », roue de couleurs, Blackout qui garde la position ;
  - MIDI (local, RTP, Web MIDI ; modes ; retour ; registre de notes), tempo, OSC, chants/setlist/suivi SPP ;
  - import QLC+ + reconstruction + auto-test (mappings, exclusivité, latence, **cadence mesurée en temps réel**) ; exports (rack, Live Set, conduite) ; conception assistée ; notes ; archives `.lightshow` ;
  - **bascule avec QLC+** : sortie en veille (`light serve --standby`), alerte « autre console », procédure dans [bascule-qlc.md](bascule-qlc.md) ;
  - actions de la timeline des chants et lecture sans DAW (▶) ; planche SVG d'un chant ; aperçu 2D en direct de la scène (page Lieu) ;
  - limites min/max des DCA (butée ou course réduite) ;
  - presets automatiques (premier allumage d'un lieu en un clic) ;
  - SDK TypeScript et Python, OpenAPI générée ([sdk/README.md](../sdk/README.md)) ;
  - CLI `light` complète (check, selftest, import, export, pack/unpack, standby, call), avec ou sans serveur en marche ;
  - reprise après un plantage ou un redémarrage rapide (état en direct de moins de 5 min) ;
  - build de production, image Docker vérifiée.
- **Interface web** : Live (dashboards modulables), Chants (avec l'éditeur de chants et de setlists), Show (avec l'éditeur de looks), Lieu, Console DMX, MIDI (dont Web MIDI), OSC, Import, Notes, Réglages ; FR/EN. **Testée dans Chromium headless** avec Playwright (`npm run test:ui`, `test/ui/`) : connexion par PIN, looks et exclusivité, Panic, fader de groupe, console DMX, chants, toutes les pages en FR/EN, éditeur de dashboard, pad XY des lyres, éditeur de looks (aperçu et pas), éditeur de chants et de setlists, refus d'écriture pour un bénévole. Les captures vont dans `test-results/` (à regarder après chaque changement visuel).

## Prochaines étapes
1. **L'utilisateur** :
   - tests matériel (prototypes) ;
   - `.qxf` personnels dans `data/fixtures/`, import de son workspace puis auto-test ;
   - premier coup d'œil à l'interface dans un navigateur ;
   - répétition v0 avec QLC+ en secours, en suivant [bascule-qlc.md](bascule-qlc.md).
2. Corriger d'après ses retours, notamment l'interface.
3. Non encore fait :
   - lyres : calibration guidée, pad XY de scène, import des EFX QLC+ ;
   - cascade complète des règles.
4. Plus tard (roadmap) : IA en live, Max for Live, AbleSet, audio, 3D, comptes et QR.

## Démarrer
```bash
npm install && npm install-scripts approve esbuild @julusian/midi && npm rebuild esbuild @julusian/midi
npm run build:web
npm run light -- pin regisseur 1234     # définir un PIN
npm run serve                            # http://localhost:8790 ; MCP sur /mcp (jeton : npm run light -- token)
```
Fichiers à déposer (hors git) : définitions `.qxf` dans `data/fixtures/`, workspace QLC+ dans `data/imports/`, coquille Ableton dans `data/private/shell.adg`.

## Règles pour les agents qui implémentent
- **Réutiliser avant d'écrire** : chercher les commandes, sélecteurs, utilitaires et schémas existants avant d'en créer. Aucune duplication. Les outils MCP, les routes OSC et HTTP et la CLI sont de minces adaptateurs sur la couche de commandes.
- **Confidentialité (dépôt public)** : aucune donnée ni intégration privée de l'utilisateur dans le dépôt. Pas de nom de lieu, d'événement, de chant ou de personne, pas d'IP, ni dans le code, ni dans la doc, ni dans les commits ou les exemples. Le privé passe par `data/plugins/` ou un dossier privé, tous deux exclus de git. **Faire un grep de contrôle avant chaque commit.**
- L'espace de travail lumière de l'utilisateur (sa référence QLC+/Ableton) est **privé**. Son chemin n'est pas noté ici : le demander à l'utilisateur, ou consulter la mémoire locale de l'agent.
- Répondre à l'utilisateur **en français**.

## Profil de l'utilisateur
- Lumière de scène avec des **chants** : setlists, sections, presets de chant.
- **Ableton Live 12 Standard** (bus IAC, MIDI clock, racks générés), AbleSet.
- Utilise aujourd'hui **QLC+**, avec des `.qxw` générés par scripts, `make` et git, et des tests MIDI de bout en bout. Utilise déjà des agents IA pour générer ses configurations.
- Connaît Daslight et la Wolfmix. Veut la souplesse de l'un et le côté « performance » de l'autre.
- Veut que l'IA comprenne la scène, et une doc soignée.

## Décisions
Le journal complet et daté est dans [decisions.md](decisions.md). Résumé :

| Sujet | Décision |
|---|---|
| Architecture | wing-mcp-server : Node/TS, `core` + plugin `light`, une seule couche de commandes |
| Jalon | Prototypes, puis **v0 « prochain culte »** (QLC+ en secours), puis phases en parallèle |
| Hébergement | **Natif sur le Mac en v1.** Linux, Pi et Docker en serveur distant via RTP-MIDI |
| Dimensionnement | 16 univers, 5 écrans ou plus ; MIDI → DMX < 10 ms |
| Sortie | Art-Net 4 (découverte) et sACN |
| Données | Machine / lieu / show ; dossier texte (git) et archive `.lightshow` ; CLI `light` et SDK |
| Lieu | Fixtures OFL et `.qxf`, scène 2D, **canevas et rendu par lieu** (central) |
| Effets | Techniques à pas (attaque, cadence, aléatoire pondéré) **et** formes d'onde |
| Groupes | **Objet Groupe unifié** : sous-groupes, master proportionnel, exclusif, limites, presets inclus ou exclus |
| Règles | 3 niveaux en v1, zones protégées, drapeaux de section, scènes sans intensité par défaut, politique strobe |
| MIDI | Déclencher / Latch / Momentané ; choix des entrées, auto-détection, profils local ↔ RTP ; registre de notes ; retour sur port distinct |
| Ableton | MIDI Effect Rack (coquille), Live Set. Max for Live et AbleSet plus tard |
| OSC | v1, avec explorateur d'adresses et table exportable |
| Chants | Grille, boutons et/ou timeline (SPP), setlist, feuille de conduite, planche |
| Existant | Import `.qxw` puis reconstruction en techniques |
| UI | Dashboards modulables, groupes de widgets, FR + EN, console DMX, éditeurs |
| Rôles | v1 : PIN par rôle. Comptes et liens/QR plus tard |
| IA | **Conception d'abord** (MCP, lint, selftest). Live plus tard |
| Panic | « Panic neutre » : rappelle le preset de scène choisi à l'avance pour le show, sinon Blackout ; plus un bouton « Blackout » |
| Dépôt | Public, open source, **licence MIT** |

## Questions encore ouvertes
Aucune. Toutes les décisions de conception sont prises ([decisions.md](decisions.md)). La suite attend le feu vert de l'utilisateur pour l'étape 0.

## Carte de la documentation
- [bascule-qlc.md](bascule-qlc.md) : **procédure de bascule avec QLC+** (sortie en veille, secours).
- [tests-mac.md](tests-mac.md) : **protocole de tests pour un agent Claude sur le Mac de régie** (MIDI, Ableton, Art-Net, import réel, auto-test).
- [install.md](install.md) : **installation et premiers pas** (Mac, Docker/Pi, import QLC+, MIDI, Ableton, IA).
- [roadmap.md](roadmap.md) : prototypes, v0, phases, plus tard.
- [decisions.md](decisions.md) : journal daté des décisions.
- [glossaire.md](glossaire.md) : vocabulaire du projet.
- [architecture.md](architecture.md) : principes, arborescence, données, WS, pipeline, auth, déploiement.
- Specs :
  - [output-artnet-sacn](specs/output-artnet-sacn.md) ;
  - [venue-fixtures-stage](specs/venue-fixtures-stage.md) (lieu, scène, canevas) ;
  - [engine-effects-timing](specs/engine-effects-timing.md) ;
  - [groups-masters](specs/groups-masters.md) ;
  - [rules-limits](specs/rules-limits.md) ;
  - [midi](specs/midi.md) (et OSC, Ableton) ;
  - [presets-songs-notes](specs/presets-songs-notes.md) ;
  - [ui-dashboards](specs/ui-dashboards.md) ;
  - [mcp](specs/mcp.md) ;
  - [plugins](specs/plugins.md) ;
  - [data-cli-sdk](specs/data-cli-sdk.md).
- [research/](research/README.md) : archives de recherche (logiciels existants, retours utilisateurs, retour d'expérience de l'utilisateur, analyse critique).

## Référence wing-mcp-server (ce qu'on sait)
- `src/index.ts` contient `bootstrap()` : ConfigStore (`data/config.json`, `MCP_CONFIG_PATH`), EventBus, le plugin, ToolVisibilityController, McpGatewayServer (HTTP), McpRuntime.
- `src/core/` : `auth, config-store, env, event-bus, health, http-body, http-errors, mcp-gateway-server, mcp-runtime, mcp-server-factory, oauth, passkeys, plugin, rate-limit, security-config, stdio-endpoint, throttle, tool-catalogue, tool-recorder, tool-visibility(-controller), transport-config, ws-codec, ws-hub, ws-rest`.
- `McpPlugin` : `id, name, start, stop, getHealth, registerTools(server), getInstructions?, getConfigSchema, getConfig, setConfig, registerHttpRoutes?(router), getToolCatalogue?, liveTopics?`.
- Le code source n'a pas été lu en détail (`gh` est absent) : on le clonera en phase 1.
