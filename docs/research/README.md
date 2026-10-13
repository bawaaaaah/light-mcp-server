# Recherche : archives

Ces documents sont des **archives** : ils expliquent d'où viennent les décisions. L'état de référence, ce sont les specs et [decisions.md](../decisions.md).

- [retour-experience-utilisateur.md](retour-experience-utilisateur.md) : **analyse de la méthode actuelle de l'utilisateur** (QLC+ généré, racks Ableton, AbleSet, tests de bout en bout). C'est la source la plus importante.
- [critique-2026-10-13.md](critique-2026-10-13.md) : analyse critique du projet et réponses adoptées.
- [software-survey.md](software-survey.md) : tour d'horizon (QLC+, Daslight, Wolfmix, Lightkey, DMXIS, SoundSwitch, grandMA3, MagicQ, Onyx, BlinderKitten, AbleSet, Companion, visualiseurs web).
- [user-feedback.md](user-feedback.md) : 20 douleurs utilisateurs des logiciels existants, et la réponse prévue pour chacune.
- [sources.md](sources.md) : liens.
- `proto-*.md` (à venir) : résultats des prototypes de l'étape 0.

## Ce que la recherche a apporté aux specs
| Apport | Origine | Spec |
|---|---|---|
| Pilotage **OSC** en v1, avec explorateur d'adresses (AbleSet plus tard) | Companion, AbleSet | [midi](../specs/midi.md) |
| Export **MIDI Effect Rack** nommé, générateur de Live Set ; Max for Live plus tard | Lightkey (Live Triggers), retour d'expérience | [midi](../specs/midi.md) |
| Modèle d'effets à pas : *width*, groups, blocks, wings, shuffle | grandMA3 | [engine](../specs/engine-effects-timing.md) |
| Deux couches d'effet par module, palette de 20 couleurs par groupe, boutons flash, presets automatiques | Wolfmix | [engine](../specs/engine-effects-timing.md), [presets](../specs/presets-songs-notes.md) |
| Zones protégées, masques par section | SoundSwitch (douleur) | [règles](../specs/rules-limits.md) |
| `schemaVersion`, migrations, backups | QLC+ (douleur) | [données](../specs/data-cli-sdk.md) |
| Widgets liés à des groupes, reciblage en masse ; exclusivité indépendante de l'UI | QLC+ (douleur) | [ui](../specs/ui-dashboards.md), [groupes](../specs/groups-masters.md) |
| Effets toujours paramétriques, copier-coller d'attributs entre types | Daslight (douleur), Lightkey | [engine](../specs/engine-effects-timing.md) |
| NRPN, 14 bits, canal réservé | DMXIS | [midi](../specs/midi.md) |
| Overlay de playbacks, tracking et release | Onyx | [ui](../specs/ui-dashboards.md), [engine](../specs/engine-effects-timing.md) |
| Boucles de N mesures | SoundSwitch | [engine](../specs/engine-effects-timing.md) |
| Références pour la future vue 3D : ASLS Studio, Beam ; architecture proche : qmsk/dmx | — | [lieu](../specs/venue-fixtures-stage.md) |

## Non retenu pour l'instant
- Analyse audio automatique (SoundSwitch, jugée imprécise) : plugin plus tard.
- Pixel mapping vidéo complet (Daslight, Onyx).
