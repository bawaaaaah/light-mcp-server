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

