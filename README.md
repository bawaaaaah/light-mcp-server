# light-mcp-server

Contrôleur lumière DMX (Art-Net / sACN) open source. On le pilote depuis une interface web temps réel (WebSocket), en MIDI ou OSC depuis Ableton et les contrôleurs, ou par une IA via MCP.

> **Statut : en développement (v0).** Installation et premiers pas : [`docs/install.md`](docs/install.md).
> Reprendre le projet : [`docs/HANDOFF.md`](docs/HANDOFF.md). Feuille de route : [`docs/roadmap.md`](docs/roadmap.md).

## En bref
- Architecture inspirée de [bawaaaaah/wing-mcp-server](https://github.com/bawaaaaah/wing-mcp-server) : Node/TypeScript, un `core/` générique et un plugin `light`, avec **une seule couche de commandes** pour l'UI, le MIDI, l'OSC, le MCP, la timeline et la CLI.
- Sortie **Art-Net 4** avec découverte des nodes, et **sACN**. Jusqu'à 16 univers.
- **Lieu, scène et canevas** : on écrit les effets sur un canevas abstrait, rendu ensuite sur le kit de chaque salle. La scène virtuelle (zones, hauteurs, orientations, rôles) est lisible par l'IA.
- **Techniques à pas** (damier, palette qui tourne, masques, orage…) avec attaque et cadence au BPM, et **effets par forme d'onde**.
- **Groupes** unifiés : sous-groupes, master proportionnel façon DCA, exclusivité, limites.
- **Règles** de sécurité : modes interdits, max UV, zones protégées, scènes sans intensité, politique strobe, Panic neutre et Blackout.
- **MIDI** :
  - entrées locales et RTP-MIDI auto-détectées ;
  - modes Déclencher, Latch et Momentané, registre de notes, retour sur port distinct, MIDI clock et SPP ;
  - export de **MIDI Effect Rack** Ableton et génération de Live Set.
- **Chants et setlist** : grille de conception, boutons et/ou timeline, feuille de conduite, planche.
- **Dashboards** modulables FR/EN, console DMX, éditeurs d'effets, d'easing et de timing, notes partout.
- **Données** en fichiers texte (git) et archives `.lightshow`, **CLI** `light` et **SDK** de scripts, **plugins**.
