# Journal des décisions

Chaque ligne est une décision **validée par l'utilisateur**. En cas de contradiction, c'est la plus récente qui prime. Les specs reflètent cet état.

| Date | Sujet | Décision | Spec |
|---|---|---|---|
| 2026-10-12 | Architecture | Calquée sur wing-mcp-server : Node ≥ 22.6, TypeScript ESM, `src/core` générique + plugin `light`, front Vite + React | [architecture](architecture.md) |
| 2026-10-12 | MCP | Dès la v1, HTTP `/mcp` + stdio | [mcp](specs/mcp.md) |
| 2026-10-12 | Sortie | Art-Net 4 avec découverte ArtPoll, plus sACN E1.31 | [output](specs/output-artnet-sacn.md) |
| 2026-10-12 | Fixtures | Format aligné sur l'OFL, import `.qxf` QLC+ | [lieu](specs/venue-fixtures-stage.md) |
| 2026-10-12 | Sources MIDI | USB/IAC local, Web MIDI, RTP-MIDI | [midi](specs/midi.md) |
| 2026-10-12 | Scène virtuelle | Zones avec hauteur, montage, orientation, rôles, lisible par l'IA | [lieu](specs/venue-fixtures-stage.md) |
| 2026-10-12 | Notes | Notes et annotations attachables partout | [chants](specs/presets-songs-notes.md) |
| 2026-10-12 | Timing | Chaque durée est fixe (s) ou musicale (temps/mesures), avec MIDI clock | [moteur](specs/engine-effects-timing.md) |
| 2026-10-12 | Chants | Un chant est une collection de boutons et/ou une timeline | [chants](specs/presets-songs-notes.md) |
| 2026-10-12 | Règles | Max par attribut, modes interdits, définis sur la fixture de base et surchargeables ; aucune limite sur les couleurs par défaut | [règles](specs/rules-limits.md) |
| 2026-10-12 | Confidentialité | Aucune intégration ni donnée privée de l'utilisateur dans le dépôt. Passer par des plugins privés | [plugins](specs/plugins.md) |
| 2026-10-12 | Plugins | Système d'extensions : commandes, MCP, connecteurs, UI, config | [plugins](specs/plugins.md) |
| 2026-10-12 | Masters | Sub-masters proportionnels façon DCA | [groupes](specs/groups-masters.md) |
| 2026-10-12 | Panic | Principe du look de secours validé | [mcp](specs/mcp.md) |
| 2026-10-13 | Modes MIDI | **Déclencher**, **Latch**, **Momentané**. Momentané fusionne On/Off et Continu : le rejeu de la note met le niveau à jour, aftertouch en option. Le mode par défaut des nouveaux boutons est réglable | [midi](specs/midi.md) |
| 2026-10-13 | Canevas | Concept central dès la v1, avec rendu sur le kit de chaque lieu | [lieu](specs/venue-fixtures-stage.md) |
| 2026-10-13 | Intensité | « Scènes sans intensité » activée par défaut | [règles](specs/rules-limits.md) |
| 2026-10-13 | Dimensionnement | 16 univers, 5 écrans ou plus | [architecture](architecture.md) |
| 2026-10-13 | Langue | FR + EN dès la v1 | [ui](specs/ui-dashboards.md) |
| 2026-10-13 | Existant QLC+ | Import des `.qxw` puis reconstruction avec les techniques paramétriques | [chants](specs/presets-songs-notes.md) |
| 2026-10-13 | Ableton | v1 : export MIDI Effect Rack et générateur de Live Set. Max for Live et AbleSet plus tard | [midi](specs/midi.md) |
| 2026-10-13 | OSC | Pilotage OSC en v1, avec explorateur d'adresses et table exportable | [midi](specs/midi.md) |
| 2026-10-13 | Effets | Modèle à pas **et** formes d'onde en v1 | [moteur](specs/engine-effects-timing.md) |
| 2026-10-13 | Panic | Deux boutons : « Panic neutre » et « Blackout » | [mcp](specs/mcp.md) |
| 2026-10-13 | Sécurité | Zones protégées et presets automatiques en v1 | [règles](specs/rules-limits.md) |
| 2026-10-13 | Données | Dossier de fichiers texte (git) sur le serveur, archive `.lightshow` téléchargeable | [données](specs/data-cli-sdk.md) |
| 2026-10-13 | Outillage | CLI headless `light` et SDK de scripts | [données](specs/data-cli-sdk.md) |
| 2026-10-13 | Dépôt | Public et open source (licence : voir plus bas) | [HANDOFF](HANDOFF.md) |
| 2026-10-13 | Audio | Synchronisation audio plus tard (plugin) | [roadmap](roadmap.md) |
| 2026-10-13 | **Analyse critique** | Ajustements ci-dessous, qui priment sur les lignes précédentes | [critique](research/critique-2026-10-13.md) |
| 2026-10-13 | Jalon | **v0 « prochain culte »** : remplacer le pipeline QLC+ actuel sur un vrai événement, avec QLC+ en secours | [roadmap](roadmap.md) |
| 2026-10-13 | Prototypes | Prototyper les paris risqués avant tout développement | [roadmap](roadmap.md) |
| 2026-10-13 | Groupes | **Objet Groupe unifié** : sous-groupes, master proportionnel optionnel, exclusif optionnel, limites, presets d'effets inclus ou exclus. Il remplace masters de groupe, sub-masters, exclusivité et solo frames | [groupes](specs/groups-masters.md) |
| 2026-10-13 | Règles | **3 niveaux en v1** (type de fixture, lieu/show, groupe/widget), plus les zones protégées et les drapeaux de section | [règles](specs/rules-limits.md) |
| 2026-10-13 | IA | **Conception d'abord** (MCP de conception, CLI, SDK, lint, selftest). IA en live plus tard | [mcp](specs/mcp.md) |
| 2026-10-13 | Rôles | Rôles fins à terme. **v1 = PIN par rôle** ; comptes et liens/QR plus tard | [architecture](architecture.md) |
| 2026-10-13 | Hébergement | **Natif sur le Mac en v1.** Linux, Pi et Docker en « serveur distant » via RTP-MIDI | [architecture](architecture.md) |
| 2026-10-13 | Entrées MIDI | Choix des entrées surveillées, auto-détection, profils d'entrées par événement (bascule local ↔ RTP-MIDI) | [midi](specs/midi.md) |
| 2026-10-13 | Licence | **MIT** | [HANDOFF](HANDOFF.md) |
| 2026-10-13 | Panic neutre | Il rappelle un **preset de scène choisi à l'avance pour le show** (le « look de secours » du show) ; **si aucun n'est défini, il fait un Blackout** | [mcp](specs/mcp.md) |
| 2026-10-13 | Moteur | Rendu immédiat à chaque changement d'état (`requestFrame`), en plus du tick à 44 Hz : nécessaire pour MIDI → DMX < 10 ms (mesure P2) | [moteur](specs/engine-effects-timing.md) |
| 2026-10-13 | MIDI Linux | MIDI local via ALSA (`snd-seq` requis), RTP-MIDI via le démon rtpmidid (ports ALSA) ; sur macOS, les sessions RTP sont des ports CoreMIDI | [proto](research/proto-resultats.md) |
| 2026-10-13 | RTP-MIDI | Implémentation AppleMIDI maison en pur Node (P7) : le paquet `rtpmidi` est abandonné ; plus besoin de rtpmidid sous Linux, Pi ou Docker | [proto](research/proto-resultats.md) |
| 2026-10-13 | OSC | Codec OSC maison (pas de dépendance) | [proto](research/proto-resultats.md) |
| 2026-10-13 | Flux WS | Canal stream : un client avec plus de 256 Kio en attente est sauté (la dernière trame remplace) | [proto](research/proto-resultats.md) |
| 2026-10-13 | Import QLC+ | Valeurs absentes d'un pas = 0 ; noms de modes comparés de façon tolérante ; reconnaissance des techniques validée à 97 % | [proto](research/proto-resultats.md) |
| 2026-10-13 | Développement | **Réutiliser le code existant**, sans duplication (règle pour les agents qui implémentent) | [HANDOFF](HANDOFF.md) |
| 2026-10-13 | Commandes | Toutes les actions passent par un registre de commandes ; outils MCP, routes HTTP et adresses OSC en sont générés (aucune logique dans les adaptateurs) | [architecture](architecture.md) |
| 2026-10-13 | Forçage console | Les forçages de la console DMX (programmer) s'appliquent après le masque de règles : c'est le « forçage technicien » | [règles](specs/rules-limits.md) |
| 2026-10-13 | Import QLC+ | Les séquences sont importées à l'identique (pas exacts) et étiquetées avec la technique reconnue ; la reconstruction paramétrique viendra ensuite, look par look | [chants](specs/presets-songs-notes.md) |
| 2026-10-13 | Interface | Interface v0 : dashboards modulables (grille, édition), console DMX, MIDI, Import + auto-test ; FR/EN | [ui](specs/ui-dashboards.md) |
| 2026-10-14 | Tests | Interface testée dans Chromium headless par Playwright (`npm run test:ui`), captures relues après chaque changement visuel | [HANDOFF](HANDOFF.md) |
| 2026-10-14 | Lyres | Position logique normalisée (0..1, centre 0,5) ; inversion, swap et 16 bits dans le lieu ; une lyre non pilotée reste au centre ; Blackout garde pan/tilt | [lieu](specs/venue-fixtures-stage.md) |
| 2026-10-14 | Move FX | Le mouvement fait partie du look (`move`) ; technique `aucune` pour les looks de position ; une position manuelle (pad XY, viser) passe devant les looks jusqu'au relâchement | [moteur](specs/engine-effects-timing.md) |
| 2026-10-14 | Éditeur de looks | Formulaire des paramètres généré depuis le schéma zod du serveur ; aperçu calculé par le serveur (`look.preview`), seul le temps est rejoué dans le navigateur | [ui](specs/ui-dashboards.md) |
| 2026-10-14 | Éditeur de chants | Page Chants : en-tête du chant, sections (look, repère, idée, mesures, position fixe), timeline proportionnelle, « remplir la grille » ; éditeur de setlist | [chants](specs/presets-songs-notes.md) |
| 2026-10-14 | Bascule QLC+ | **Sortie en veille** (le show tourne et suit le MIDI, rien n'est envoyé, retour MIDI coupé ; gardée au redémarrage ; trame à zéro en entrant) et alerte « autre console » ; procédure écrite ; sur un Mac partagé avec QLC+, découverte coupée par prudence | [bascule](bascule-qlc.md) |
| 2026-10-14 | Tempo | Temps moteur (cadence des looks) séparé de la position du chant : il suit les ticks, continue au dernier tempo sans horloge et ignore les sauts ; corrige des looks figés quand Live est arrêté et bloqués après un recul | [moteur](specs/engine-effects-timing.md) |
| 2026-10-14 | Auto-test | Mesure de la cadence de chaque look sur la sortie réelle, en option (critère v0 « mesure de la cadence ») | [moteur](specs/engine-effects-timing.md) |
| 2026-10-14 | Reprise | Après un redémarrage, l'état en direct (looks, Blackout, chant) est restauré s'il a moins de 5 minutes ; sinon rien ne se rallume | [données](specs/data-cli-sdk.md) |
| 2026-10-14 | CLI | `light` passe par l'API du serveur s'il tourne, sinon ouvre les données directement (jamais deux écrivains) ; commandes check, selftest, import, export, pack/unpack, standby, call | [données](specs/data-cli-sdk.md) |
| 2026-10-14 | Presets automatiques | 6 palettes + 6 looks (une technique chacun) + groupe exclusif, look de secours si absent ; jamais d'écrasement | [chants](specs/presets-songs-notes.md) |
| 2026-10-14 | SDK | Clients TypeScript et Python sans dépendance, OpenAPI générée depuis le registre de commandes (une route par commande, droit en `x-right`) | [données](specs/data-cli-sdk.md) |
| 2026-10-14 | Timeline | Actions = commandes placées en mesures, déclenchées en lecture normale seulement (jamais sur un saut) ; lecture interne `song.play` sans DAW, l'horloge MIDI garde la priorité | [chants](specs/presets-songs-notes.md) |
| 2026-10-14 | Planche | Storyboard SVG d'un chant généré par le serveur (bandes de sections, pas en couleurs, repères, actions) ; le plan de salle par section viendra plus tard | [chants](specs/presets-songs-notes.md) |
| 2026-10-14 | Aperçu 2D | Couleurs relues dans la sortie DMX réelle (ce qu'on voit = ce qui part), flux `light:preview` ; projecteurs sans position alignés devant ; pas d'emoji dans l'interface (rendu sans police emoji) | [lieu](specs/venue-fixtures-stage.md) |
| 2026-10-14 | Règles | Correctif : chaque borne vient de la règle la plus précise (le show peut assouplir le type), conflit min/max tranché par la plus précise, `locked` par-dessus ; `rule.effective` avec provenance | [règles](specs/rules-limits.md) |
| 2026-10-14 | Vocabulaire | **DCA** = le fader d'un groupe (pas « sub-master » ni « fader de groupe ») ; Groupe = l'objet | [groupes](specs/groups-masters.md) |
| 2026-10-14 | Limites DCA | min/max sur le niveau du groupe, mode butée (défaut) ou course réduite ; mute = 0 ; flash plafonné au max | [groupes](specs/groups-masters.md) |
| 2026-10-14 | Import EFX | EFX QLC+ → look de position + Move FX sur un groupe ; formes absentes approximées et signalées ; Serial = têtes réparties sur un cycle | [chants](specs/presets-songs-notes.md) |
| 2026-10-14 | Calibration des lyres | Repères visés à la main → yaw, décalage de tilt, inversions (le décalage de pan est confondu avec le yaw) ; écart > 3° signalé | [lieu](specs/venue-fixtures-stage.md) |
| 2026-10-14 | Lecture seule | Une commande qui peut écrire (apply/save), jouer le show ou injecter du MIDI n'est jamais marquée readOnly (promesse faite aux clients IA) ; test de contrat | [mcp](specs/mcp.md) |
| 2026-10-15 | Exports Ableton des programmes | Clip `.alc` par programme cloné depuis un clip de l'utilisateur (nom et Program Change du premier clip seulement) ; `.mid` par chant (notes des looks, Program Change) ; Live ignore a priori les PC des `.mid` importés | [midi](specs/midi.md) |
| 2026-10-15 | Programmes de règles | Règles par moment du culte : un programme actif à la fois, activé par Program Change MIDI (sans mapping), par une section de chant ou à la main ; une section sans programme garde le programme actif (choix de l'utilisateur) | [règles](specs/rules-limits.md) |
| 2026-10-15 | Programme par note | Un mapping MIDI (note, CC ou PC) peut activer un programme de règles ou n'en activer aucun : secours si Live ignore les Program Change d'un `.mid` importé | [midi](specs/midi.md) |
| 2026-10-15 | Gradateur générique QLC+ | Le « Generic / Generic » de QLC+ (sans `.qxf`) est intégré ; un fader QLC+ sur une lampe sans couleur devient un fader de canaux (comme dans QLC+), un DCA seulement sur des projecteurs à couleurs | [lieu](specs/venue-fixtures-stage.md) |
| 2026-10-15 | Éditeur de faders de canaux | Un fader se crée dans l'UI sur plusieurs projecteurs à la fois, canaux choisis par nom ; doser des looks reste le rôle du DCA | [groupes](specs/groups-masters.md) |
| 2026-10-15 | Canaux bruts dans les looks | Un look peut régler des canaux bruts (machines, lampes) pas à pas, sans fondu, même sans définition ; l'import QLC+ y convertit les séquences sans couleur (fumée, hazer) | [moteur](specs/engine-effects-timing.md) |
| 2026-10-15 | Submaster sur des faders | Un Submaster QLC+ dose aussi les faders « Level » de son cadre : leurs DCA deviennent ses sous-groupes, leurs faders de canaux sont dosés par lui (`dca`) | [groupes](specs/groups-masters.md) |
| 2026-10-15 | Scenes QLC+ et fondu d'entrée | Une Scene lancée par un widget devient un look d'un pas ; le fondu d'entrée des looks (jusque-là jamais joué) part du noir | [moteur](specs/engine-effects-timing.md) |
| 2026-10-15 | Modes des boutons de dashboard | Boutons de look et Blackout : marche/arrêt (défaut), tant qu'on appuie, ou déclencher, choisis par bouton | [ui](specs/ui-dashboards.md) |
| 2026-10-15 | Publication | Comme wing-mcp-server : `@bawaaaaah/light-mcp-server` sur GitHub Packages et image multi-arch sur GHCR, publiés à chaque commit de `main` dont la CI passe (auto-tag) ; installé depuis npm, les données vont dans `./data` du dossier courant | [install-npm](install-npm.md) |
| 2026-10-15 | Réimport | Mode hybride : empreintes de l'import ; inchangé → mis à jour, retouché → conservé et signalé ; état en direct et champs utilisateur toujours gardés ; `replace` explicite | [chants](specs/presets-songs-notes.md) |
| 2026-10-15 | Faders QLC+ | Fader « Level » hors gradateur → **fader de canaux** (HTP, par décalage, sans définition requise, démarre à 0) ; Submaster → DCA dosant les looks de son cadre | [groupes](specs/groups-masters.md) |
| 2026-10-15 | Niveaux en direct | DCA et faders : appliqués tout de suite, écrits une fois 1 s après le dernier mouvement, sans copie de sauvegarde (avant : une copie par mouvement) | [groupes](specs/groups-masters.md) |
| 2026-10-14 | Fixtures sans mélange | Lampe + roue de couleurs ou gradateur seul : la couleur peinte choisit le créneau de roue le plus proche et son niveau pilote le gradateur (éteint si rien n'est peint) | [lieu](specs/venue-fixtures-stage.md) |

