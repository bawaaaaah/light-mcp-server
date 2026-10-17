# HANDOFF — reprendre le projet

Point d'entrée pour un agent ou un humain qui reprend le projet. **À lire en premier.**

## Où on en est (2026-10-17)
- **v0 fonctionnellement complète côté logiciel**, en attente des tests matériel de l'utilisateur (fin de semaine).
- **Prototypes** : [research/proto-resultats.md](research/proto-resultats.md). **Tests sur le Mac (2026-10-14)** : P1 (bus IAC), P2, P3 (rack chargé dans Live), P4/P5 (horloge, SPP, aftertouch depuis Live), P7, P9 à P11 validés ; **vrai show importé et auto-testé : 92/92 mappings, cadence 100 %**. Restent : P8 (Live Set dans Live), P6 et la bascule QLC+ sur le réseau lumière, hotplug USB, regard sur la vraie scène ; **réimporter le workspace** sur le Mac (la réimportation garde les retouches faites à la main, voir [tests-mac](tests-mac.md) § 6 bis) : depuis le 2026-10-15 l'import convertit aussi les Scenes et matrices RGB lancées par un widget, les faders Playback, les Submasters au milieu de faders, les séquences de machines (canaux bruts), le gradateur « Generic » ; copier d'abord dans `data/fixtures/` les `.qxf` du dossier QLC+ de l'utilisateur et ceux fournis avec QLC+. **Vérifié hors Mac sur les 16 workspaces de l'utilisateur** : aucune définition manquante, plus aucune fonction lancée par un widget laissée de côté (hors fonctions vides ou supprimées) ; sur deux d'entre eux, tous les looks allument, lint sans erreur, auto-test 100 %.
- **Serveur** (`npm test` : 339 tests verts ; `npm run test:ui` : 84), avancement détaillé dans [roadmap.md](roadmap.md) :
  - registre de commandes unique → outils MCP, routes HTTP, adresses OSC ;
  - sortie Art-Net/sACN + découverte ;
  - lieu (patch, canevas, scène, zones protégées), show (palettes, looks, techniques dont ondes, groupes façon DCA), règles ;
  - lyres : pan/tilt 16 bits, Move FX dans les looks, position manuelle et « viser une zone », roue de couleurs, Blackout qui garde la position ;
  - MIDI (local, RTP, Web MIDI ; modes ; retour ; registre de notes), tempo, OSC, chants/setlist/suivi SPP ;
  - import QLC+ + reconstruction + auto-test (mappings, exclusivité, latence, **cadence mesurée en temps réel**) ; exports (rack, Live Set, conduite) ; conception assistée ; notes ; archives `.lightshow` ;
  - **bascule avec QLC+** : sortie en veille (`light serve --standby`), alerte « autre console », procédure dans [bascule-qlc.md](bascule-qlc.md) ;
  - actions de la timeline des chants et lecture sans DAW (▶) ; planche SVG d'un chant ; aperçu 2D en direct de la scène (page Lieu) ;
  - looks à **canaux bruts** (boutons machine : fumée, hazer, lampe) ; faders de canaux sur plusieurs projecteurs (éditeur), dosables par un DCA ; DCA « playback » ; fondu d'entrée des looks ;
  - limites min/max des DCA (butée ou course réduite) ; programmes de règles (par section, par Program Change MIDI), avec clips `.alc` et fichiers `.mid` pour Ableton ;
  - presets automatiques (premier allumage d'un lieu en un clic) ;
  - SDK TypeScript et Python, OpenAPI générée ([sdk/README.md](../sdk/README.md)) ;
  - CLI `light` complète (check, selftest, import, export, pack/unpack, standby, call), avec ou sans serveur en marche ;
  - reprise après un plantage ou un redémarrage rapide (état en direct de moins de 5 min) ;
  - build de production, image Docker vérifiée ;
  - **app de barre de menus macOS** (`macos/`, comme wing-mcp-server) : démarre, arrête, recompile et relance le serveur ; un port RTP-MIDI occupé ne bloque plus le démarrage ; ouvre l'interface déjà connectée (`#token=`) ;
  - **shows et sauvegardes** comme une console lumière (page Fichiers, `light show`, `light backup`) ;
  - **instantanés** (état complet rappelé d'un coup) et **secours complet** du Panic neutre ;
  - **utilisateurs** nommés (rôle, PIN, clés de sécurité YubiKey / passkeys) et **OAuth** pour claude.ai, repris de wing-mcp-server ;
  - **import QLC+ guidé** (définitions `.qxf` depuis le navigateur, workspace dans le show ouvert ou dans un nouveau show) ;
  - **clic droit sur les widgets** des dashboards (cible, libellé, mode, couleur, apprentissage MIDI, retrait ; appui long sur tablette) ;
  - **droits appliqués partout** (pages, contrôles du Live, outils MCP), **éditeur de rôles**, page **Mon compte** (clés), nouvelle **mise en page** (barre latérale ; onglets sur tablette, bande qui défile sur téléphone), tour Playwright de chaque rôle (ordinateur, tablette, téléphone, anglais, show vide) ;
  - **connexion** : jeton d'authentification par défaut, PIN pour un utilisateur choisi, liens de partage (utilisateur + PIN), essais de PIN limités ; `server.port` / `server.host` dans `data/machine/config.json` ; page **Connexion IA** et doc du reverse proxy (README) ;
  - **2026-10-16** :
    - dashboards : glisser-déposer, coins pour redimensionner, grille magnétique, jusqu'à 64 colonnes (défilement horizontal), palette, annuler/rétablir, plein écran, couleurs des widgets, appui long ;
    - séparation des deux workspaces en deux shows ; « autre console » reconnue au contenu des paquets (une autre instance sur la même machine est signalée « cette machine ») ;
    - console DMX par projecteur ; onglets sur deux lignes sur tablette ; interface entièrement traduite en anglais ; guide **Pour commencer** sur un show neuf ;
    - **sessions** gardées par empreinte et prolongées à l'usage (un redémarrage ne déconnecte plus les tablettes) ; bandeau « liaison coupée » ; retour à la connexion si la session est refusée ;
    - page Show : recherche et filtre par dossier QLC+, pastilles de couleur, faders de canaux nommés ; **suppression refusée** tant qu'un objet sert (`show.references`, `force`) ; noms en double signalés par « Vérifier le show » ;
    - **sauvegarde automatique** quotidienne (14 gardées), historique par objet borné, **versions précédentes** et **récemment supprimés** (looks, groupes, faders, dashboards) ;
    - en-têtes anti-encadrement (clickjacking) ; **journal d'activité** (qui, d'où, quoi ; la dernière semaine, gardée d'un redémarrage à l'autre ; la CLI s'y annonce) et **qui est en ligne** dans Réglages ;
    - patch : **chevauchements d'adresses** et projecteurs **sans définition** signalés (au patch, `venue.patch.check`, « Vérifier le show », page Lieu triée par adresse) ; mappings MIDI de même libellé pour des cibles différentes signalés ; mappings triés par numéro, avec recherche ; notes groupées par type ;
    - **légèreté** : `look.list` résumé par défaut (un show importé pesait près d'1 Mo, rechargé à chaque appui sur le Live), `look.get` pour un look entier, un look partiel refusé par `look.put` ; fichiers de l'interface en cache immuable ; message de validation précis (premier problème et son chemin) ;
    - **tablettes de scène** : installable sur l'écran d'accueil (manifeste, icône), écran gardé allumé en plein écran, « Rester connecté sur cet appareil » en option ; un rechargement pendant un redémarrage garde la session (« Serveur injoignable », nouvel essai) ;
    - **MCP** : instructions d'initialisation à jour (un test vérifie chaque outil cité), les **sept prompts** de la spec (`preshow_check`, `import_qlc_project`, `setup_venue`, `define_canvas`, `program_song`, `build_setlist`, `rehearsal_review`), ressources `light://rules`, `light://midi/map`, `light://osc/map`, `light://notes`, `light://log` (lues avec les droits de l'appelant) ; `light://live` dit la veille et les canaux forcés ; l'événement `light:command` allégé ;
    - **console DMX** : « pourquoi ce canal » (`dmx.explain` : projecteur, DCA, faders, looks, règles, forçage) ; les canaux forcés s'affichent dans l'en-tête de toutes les pages ; « Vérifier le show » ouvre sur un résumé ; `light activity` dans la CLI.
    - **sécurité** : « ↶ Revenir » après un Panic appuyé par erreur (une minute) ; « Vérifier le show » signale les looks qui clignotent plus de 3 fois par seconde et les canaux bruts ramenés par une règle.
  - **2026-10-17** :
    - **scène en direct** : orientation des projecteurs (public, mur de scène, jardin, cour, plafond, sol ; rotation par boutons, clavier, angle ou glisser ; `venue.fixture.orient`), **faisceaux** de la couleur de chaque projecteur jusqu'à l'impact au sol (lyres d'après le pan/tilt réellement envoyé, ouverture de l'optique de la définition), repère fixe du **strobe** en cours, **zoom** ×1 à ×4 ;
    - règles : **Strobe max (Hz)** là où la définition donne les fréquences, et « Vérifier le show » nomme les projecteurs où il reste sans effet ;
    - dashboards : boutons **à confirmer** (deux appuis pour allumer) ; le menu d'un widget tient dans l'écran ;
    - **annuler une modification** depuis sa ligne du journal d'activité (`history.undo`, bouton ↶ dans Réglages, aussi pour l'IA) ;
    - **proposer avant d'écrire** : `show.diff` (ce qu'un enregistrement changerait, champ par champ), demandé à l'IA par les instructions MCP, et `light call … --check` ;
    - lieu : **zones rectangulaires** créées depuis la page Lieu ; **placer la sélection** d'un coup le long d'un bord de zone (`venue.fixture.arrange`) ;
    - **messages du serveur en anglais** quand l'interface l'est (`core/lang.ts`, en-tête `x-light-lang`), français par défaut.
- **Interface web** : Live (dashboards modulables), Chants (avec l'éditeur de chants et de setlists), Show (avec l'éditeur de looks), Lieu, Console DMX, MIDI (dont Web MIDI), OSC, Import, Notes, Réglages ; FR/EN. **Testée dans Chromium headless** avec Playwright (`npm run test:ui`, `test/ui/`) : connexion par PIN, looks et exclusivité, Panic, fader de groupe, console DMX, chants, toutes les pages en FR/EN, éditeur de dashboard, pad XY des lyres, éditeur de looks (aperçu et pas), éditeur de chants et de setlists, éditeurs de groupes/DCA, de faders de canaux, de règles et de mappings MIDI (avec « Apprendre », programmes par note), boutons de dashboard marche/arrêt, tant qu'on appuie ou déclencher, toutes les pages au format tablette, calibration des lyres, orientation des projecteurs sur la scène en direct, boutons à confirmer, refus d'écriture pour un bénévole. Les captures vont dans `test-results/` (à regarder après chaque changement visuel).

## Prochaines étapes
1. **L'utilisateur** :
   - tests matériel (prototypes) ;
   - `.qxf` personnels dans `data/fixtures/`, import de son workspace puis auto-test ;
   - premier coup d'œil à l'interface dans un navigateur ;
   - répétition v0 avec QLC+ en secours, en suivant [bascule-qlc.md](bascule-qlc.md).
2. Corriger d'après ses retours. **Demandes de l'utilisateur du 2026-10-15, pas encore faites** :
   - **interface** : retours de l'utilisateur sur la nouvelle mise en page, les couleurs et l'édition des dashboards.
   - choisi par l'utilisateur le 2026-10-16 : la liste des utilisateurs à PIN reste visible sur l'écran de connexion, même depuis l'adresse publique.
3. Non encore fait :
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
| Rôles | Utilisateurs nommés (rôle, PIN, clés de sécurité), jeton par défaut, liens de partage, OAuth pour les clients IA. QR plus tard |
| IA | **Conception d'abord** (MCP, lint, selftest). Live plus tard |
| Panic | « Panic neutre » : rappelle l'instantané de secours (état complet), sinon le look de secours, sinon Blackout ; plus un bouton « Blackout » |
| Dépôt | Public, open source, **licence MIT** |

## Questions encore ouvertes
Aucune. Toutes les décisions de conception sont prises ([decisions.md](decisions.md)). La suite attend le feu vert de l'utilisateur pour l'étape 0.

## Carte de la documentation
- [bascule-qlc.md](bascule-qlc.md) : **procédure de bascule avec QLC+** (sortie en veille, secours).
- [tests-mac.md](tests-mac.md) : **protocole de tests pour un agent Claude sur le Mac de régie** (MIDI, Ableton, Art-Net, import réel, auto-test).
- [install.md](install.md) : **installation et premiers pas** (Mac, Docker/Pi, import QLC+, MIDI, Ableton, IA).
- [../macos/README.md](../macos/README.md) : **app de barre de menus** (Mac de régie).
- [install-npm.md](install-npm.md) : **installation depuis GitHub Packages** (paquet publié à chaque commit de `main` dont la CI passe ; image Docker sur GHCR).
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
