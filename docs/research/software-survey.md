# Tour d'horizon des logiciels et contrôleurs lumière

Recherche du 2026-10-12. Pour chaque outil : ce qu'il fait bien, les concepts d'UI, et **ce qu'on reprend** (→).

## QLC+ (open source, multi-plateforme)
- **Functions** : Scene, Chaser, Sequence (chaser lié à une scène), EFX (circle, figure‑8, line, triangle), RGB Matrix (text, plasma, fire…), Collection, Show (timeline), Audio.
- **Virtual Console** : boutons, sliders, XY pad, cue list, speed dial avec tap, frames et pages, solo frames. La version 5.1 (2026) ajoute un widget XY Pad et des triggers audio, ainsi qu'un beat tracker audio expérimental.
- **QLC+ 5** : passage à Qt6 et prévisualisation 3D. À la sortie, environ 85 % de parité avec la v4, sans web ni Raspberry Pi, et « UI style locked ».
- **Simple Desk** (console de faders), **input profiles** MIDI (.qxm) avec feedback, serveur web intégré pour le pilotage à distance.
- → On reprend le modèle des Functions, les input profiles, le speed dial avec tap, les solo frames (exclusivité dans un groupe de boutons) et l'import `.qxf` / `.qxw`.

## Daslight 5 (Nicolaudie)
- Moteur **XEEL** : effets pixel ou chase, matrice vidéo, effets de position, **effets de courbe** sur canaux.
- **Scènes** en groupes de couleur, **empilables** (plusieurs scènes ou effets superposés).
- **Mode Show** : écran entièrement personnalisable (pad pan/tilt, roues de couleur, boutons, faders, sub-masters), plusieurs commandes sur un même contrôle.
- Mapping clavier, MIDI ou DMX en un clic. Synchronisation par tap, MIDI clock ou Ableton Link. Timeline. Applications mobiles. Bibliothèque de plus de 20 000 fixtures.
- → On reprend les scènes empilables, le contrôle multi-commandes et le mapping en un clic.

## Wolfmix W1 (MK2/MK3, Nicolaudie)
- **3 modules FX**, chacun produisant **2 effets simultanés** :
  - Color FX : Rainbow, Sparkle, Chaser, Lightning Sparkle…, jusqu'à 16 couleurs ;
  - Move FX : Circle, 8 Ball, Magic Carpet, Sequencer ;
  - Beam FX : Sin, Heartbeat, 3 Sequencers.
- **8 groupes**, **palette de 20 couleurs statiques par groupe**, **80 boutons « live edit » nommables**, **200 presets nommables** avec hold et fade, 6 projets.
- **6 boutons flash** : Special FX, Strobe, Blinder, Speed, Blackout, Smoke.
- Synchronisation : pulse audio (micro ou line), Ableton Link, OS2L, tap, MIDI clock. Presets déclenchables en MIDI. WLINK pour lier plusieurs Wolfmix.
- **Presets générés automatiquement** à partir des fixtures déclarées (très apprécié des utilisateurs).
- → On reprend les deux effets simultanés par module, la palette par groupe, les boutons flash dédiés, la **génération automatique de presets de départ** et la logique « performance sans programmation ».

## Lightkey (macOS)
- Interface en **une seule fenêtre**. **Live Preview 2D** avec des faisceaux virtuels qui reflètent intensité, couleur, focus, zoom, iris, frost et strobe aux positions réelles.
- **Stage editor graphique** (formes, truss, image de fond), **calibration pan/tilt avec calcul de position réelle**.
- **Preset Palette**, **Live tab** (cues glissés-déposés), Control Panel personnalisable.
- Plus de 70 modèles d'effets (pattern, curve, movement) qui **restent éditables** une fois stockés dans presets et cues.
- **Copier-coller de propriétés entre fixtures de types différents**. Undo illimité, autosave, dark mode, beaucoup de raccourcis clavier, assistant d'installation.
- **Live Triggers** : on glisse des cues Lightkey sur la timeline d'Ableton Live, et le show est joué sans intervention.
- Plus de 7000 profils de fixtures, Art-Net, sACN, OLA, Philips Hue.
- → On reprend la calibration pan/tilt vers une position réelle (déjà dans notre stage model), les effets toujours éditables, le copier-coller inter-types (grâce aux attributs normalisés) et **l'équivalent de Live Triggers** (export Drum Rack et `.mid`, plus tard un device Max for Live).

## DMXIS (ENTTEC, legacy)
- Plugin **VST/AU** dans la DAW. Les 512 canaux sont exposés en **lanes d'automation**.
- Changement de banque ou de preset par **notes MIDI sur les canaux 15/16** depuis des clips Ableton. Approche **basée sur le tempo**, avec un « Bank Tempo ».
- MIDI Learn avec NRPN 7 et 14 bits.
- → On reprend la convention « canal MIDI réservé pour sélectionner chant ou preset », le **support NRPN et CC 14 bits** et le tempo par banque ou par chant.

## SoundSwitch (Serato / Engine DJ)
- **Autoloops** : 32 boucles en 4 banques, jusqu'à 128 mesures, toujours calées sur le temps.
- **Autoscripting** : analyse audio par lots, puis show généré par phrase (couplet, refrain…), avec édition des phrases.
- Ableton Link, MIDI clock, MIDI timecode. Performance mode avec upfaders et crossfader mappables.
- → On reprend les **boucles d'ambiance calées sur la mesure** (preset FX de N mesures) et la **structure par sections** (déjà prévue dans nos chants). L'analyse audio automatique reste pour plus tard.

## grandMA3 (MA Lighting)
- **Phasers** : les effets sont des pas d'attributs, absolus ou **relatifs**, avec des couches **Width** (durée de transition en % de temps), **Speed**, **Phase**, et la répartition **Groups, Blocks, Wings, Selection Shuffle**.
- → On reprend directement le modèle de spread : groups, blocks, wings, shuffle, valeur relative, et la **largeur de transition en % de temps** (utile pour les FX en mode BPM).

## ChamSys MagicQ
- Orientée **cue stacks**. Fenêtres Palettes, Plot, Execute, Color Picker, Programmer, Outputs. Playbacks et pages (200 pages), fenêtre **Execute** (grille de boutons et faders configurable). Audio timeline editor, visualiseur intégré (MagicVis).
- Courbe d'apprentissage réelle pour qui vient des « petites consoles à boutons ».
- → On reprend la fenêtre Execute (déjà couverte par nos dashboards), les pages de playbacks et l'éditeur de timeline audio.

## Onyx (Obsidian)
- Cue lists avec **tracking**, **release** de paramètres dans un cue, **overlay de contrôle virtuel** (accès aux playbacks par-dessus n'importe quel écran).
- Pixel composer DyLOS : zones, gobo mapping, **masquage de groupes** (exclure un groupe d'une zone d'effet).
- Art-Net et sACN avec sync et priorités. Timecode par entrée audio.
- → On reprend le **masquage et l'exclusion de groupes ou zones**, l'overlay de playbacks et le tracking ou release dans les cue stacks.

## BlinderKitten (gratuit, open source)
- Logiciel orienté fixtures (on ne manipule pas les canaux). Cuelists, Art-Net multi-univers, OSC et MIDI, fonctionne sur Raspberry Pi. Aucune fonction bridée.
- → Il confirme qu'un logiciel libre complet a un public.

## Écosystème autour
- **AbleSet** (Ableton) : setlists à partir des **cue markers** d'Ableton, sections, paroles, **entièrement pilotable en OSC**. → Prévoir une **entrée OSC** et une intégration AbleSet (chant et section courants → chant et section lumière).
- **Bitfocus Companion / Stream Deck** : très répandu en régie, notamment dans les églises, et parle OSC et HTTP. → Exposer une **API HTTP/OSC simple** (déclencher un bouton, un chant, une section) et éventuellement publier un module Companion.
- **Visualiseurs web** : ASLS Studio (open source, three.js, faisceaux volumétriques, brouillard), Beam (Vue 3 + three.js), thread‑3d. → Bonnes références pour notre future vue 3D, voire une réutilisation.
- **qmsk/dmx** : contrôleur Go avec découverte Art-Net et UI web en WebSocket. C'est l'architecture la plus proche de la nôtre et une référence utile.
- **Open Fixture Library** : bibliothèque de fixtures au format JSON (déjà retenue).
