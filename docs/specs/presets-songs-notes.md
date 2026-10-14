# Palettes, presets, chants, notes et import QLC+

## Périmètre
| v1 | Plus tard |
|---|---|
| Palettes, presets paramétrables, **presets automatiques**, chants (grille, boutons, timeline), setlist, feuille de conduite, planche, notes, base de connaissances, import `.qxw` puis reconstruction | Connecteur AbleSet, analyse audio (plugin), sources de chants externes (plugins) |

## Nommage
Tout objet a un `name`, des `tags` (humeur, usage, saison, couleur dominante), une `description` et des `notes`. Ils servent à la recherche dans l'UI et à l'IA.

## Palettes
- Jeux nommés de 1 à 16 couleurs (RGB, avec W, A et UV optionnels).
- **Par référence** : modifier une palette met à jour tout ce qui l'utilise. Un détachement explicite permet de figer une copie. QLC+ ne permettait pas de réutiliser les couleurs.
- **Palette de 20 couleurs statiques par groupe** (Wolfmix), en plus des palettes globales.

## Presets paramétrables
- Un preset est un **modèle** : une technique, un effet ou un look, avec des emplacements à remplir : palette, cible (canevas, groupe ou rôle), profil de cadence, taille, spread.
- On l'instancie en remplissant les emplacements, par exemple « Palette qui tourne » + palette « Intime bleu/ambre » + canevas « fond ».
- Banque globale et **banques par chant** (par référence ou par copie).
- **Presets automatiques** (Wolfmix) : dès le patch et le canevas définis, on génère des palettes de base et les techniques principales appliquées au canevas du lieu. Le premier allumage est immédiat.

## Chants
### Modèle
```
Chant {
  titre, tonalité?, bpm, signature, palette par défaut, tags, notes
  ambiance: 1-2 mots-clés            // garde-fou : une section hors famille est signalée
  sections: [ {
     nom, repère (« l'entrée franche du groupe »), idée-clé, ambiance,
     dominante, accent, énergie (nb de pas, profil de cadence, ordre),
     transition, look | technique, drapeaux (manualOnly, noCut, plancher, règles machines),
     bouton (mode par défaut : Déclencher), note MIDI (registre)
  } ]
  timeline?: pistes d'actions en secondes ou en mesures/temps
}
```

- **Grille de chant** (retour d'expérience) : section → idée-clé → ambiance → dominante et accent → énergie → transition. L'UI rappelle la règle d'or : on ne change de couleur que si l'idée-clé change.
- **Deux modes combinables** :
  1. **Collection de boutons** : un dashboard par chant, chargé automatiquement quand on le sélectionne. Les sections sont dans un **groupe exclusif**.
  2. **Timeline** : pistes d'actions (look, technique, palette, niveau de groupe, cue GO, dashboard), placées en secondes ou en mesures. Les marqueurs de section servent aussi de boutons de saut.
     - **Départ** : à la main, sur une note MIDI ou sur MIDI Start.
     - **Suivi** : MIDI clock et **SPP**, avec rétablissement de la section courante.
- **Réutilisation** : un chant repris un autre jour pointe vers les mêmes looks, mais garde ses propres boutons et notes.
- **Éditeur** (v1, page Chants) : en-tête (titre, tonalité, BPM, temps par mesure, ambiances, palette, début dans Live), sections (nom, look, repère, idée, mesures, position fixe facultative, ordre), **timeline proportionnelle** (une section sans look apparaît en rouge) et « **remplir la grille** » (`song.grid_fill` sur le canevas choisi). Les pistes d'actions de la timeline restent à faire.

### Setlist
- Liste ordonnée de chants avec suivant et précédent (MIDI, OSC), sélection par Program Change ou par le canal réservé.
- Le chant courant est publié sur `light:song`.
- Éditeur de setlist (v1) : nom, ajout de chants, ordre.

### Exports
- **Feuille de conduite** (Markdown/PDF) : par chant, les sections, le bouton et la note, le repère, la tonalité, le BPM, l'arc d'énergie et les sécurités.
- **Planche** (SVG/PDF) : storyboard d'un chant (X = canevas, Y = temps, avec montée, maintien et descente) et plan de la salle par section.
- Racks Ableton, `.mid` et Live Set : voir [midi](midi.md).

## Base de connaissances couleur
- **Format générique** livré dans le dépôt :
  - 8 axes d'ambiance (intensité, température, saturation, direction, diffusion, mouvement, texture, rythme) ;
  - table sentiments → couleurs ;
  - combinaisons éprouvées ;
  - journal chant → palette.
- **Le contenu personnel de l'utilisateur** se charge depuis un **plugin ou dossier privé** et n'est jamais versionné.
- Règle par défaut : **la couleur ne touche pas la peau**. Le rôle `face` reste en blanc.
- C'est la source de `light_look_from_intent` et de `light_song_grid_fill` ([mcp](mcp.md)).

## Notes partout
- Champ `notes` (Markdown court, horodaté) sur **chaque objet** : fixture, zone, groupe, look, preset, palette, section, cue, mapping, dashboard, widget, node, univers.
- **Annotations libres** : post-it sur la scène, commentaires à un temps donné sur la timeline.
- Une icône 🗒 apparaît sur tout objet annoté. La page **Notes** offre une recherche globale. Les notes sont incluses dans les ressources MCP et accessibles par `light_note_*`.

## Import QLC+ puis reconstruction
1. **Import `.qxw`** :
   - fixtures (avec `.qxf`), groupes ;
   - fonctions Scene, Sequence (SpeedModes Common/PerStep, FadeIn/Hold/FadeOut, RunOrder dont Random), Chaser, RGBMatrix, Collection ;
   - Virtual Console : SoloFrame, Button et Slider avec leurs `<Input>` MIDI, SpeedDial avec les multiplicateurs par fonction ;
   - le profil d'entrée `.qxi` sert à retrouver les noms.
2. **Analyse** : extraction des palettes récurrentes, des structures de séquences, des notes MIDI (vers le registre) et des conventions de nommage.
3. **Reconstruction** : chaque séquence est reconvertie, quand c'est possible, en **technique paramétrique** sur un canevas (damier, palette qui tourne, masques, orage…). Elle devient éditable et portable. Ce qui ne se reconnaît pas reste une séquence à pas importée telle quelle.
4. Tout passe par une **proposition** (diff) avant d'être appliqué. En **mode hybride**, une réimportation conserve ce qui a été ajusté à la main.

## Tests
- Palettes par référence et détachement.
- Instanciation de presets, presets automatiques sur un canevas.
- Sérialisation aller-retour de tous les types (SoundSwitch perdait des données de presets).
- Timeline suivie par une clock simulée et SPP.
- Grille : section hors famille signalée.
- Import d'un `.qxw` d'exemple neutre, reconstruction reconnue sur les techniques connues, mode hybride.
