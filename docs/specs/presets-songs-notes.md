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
- **Presets automatiques** (Wolfmix, v1) : dès le patch et le canevas définis, on génère des palettes de base et les techniques principales appliquées au canevas du lieu. Le premier allumage est immédiat.
  - `show.autopresets` (bouton « ★ Presets automatiques » de la page Show) : 6 palettes tirées de la base de connaissances (blanc chaud, intime, calme, joie, fête, force) et 6 looks qui les utilisent **par référence** (plat, respiration, onde, palette qui tourne, damier, creux), cadences et attaques selon l'énergie, dans un groupe exclusif ; le blanc chaud devient le look de secours si le show n'en a pas.
  - Proposition d'abord ; les éléments `auto-*` déjà présents ne sont **jamais écrasés** (les retouches survivent à une nouvelle génération).

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
- **Éditeur** (v1, page Chants) : en-tête (titre, tonalité, BPM, temps par mesure, ambiances, palette, début dans Live), sections (nom, look, repère, idée, mesures, position fixe facultative, ordre), **timeline proportionnelle** (une section sans look apparaît en rouge) et « **remplir la grille** » (`song.grid_fill` sur le canevas choisi). **Actions de la timeline** (v1) : n'importe quelle commande (lancer ou arrêter un look, niveau, flash ou coupure d'un groupe, Blackout…) placée à une mesure et un temps ; validée à l'enregistrement (commande connue, arguments valides, jamais une commande de chant). Elles se déclenchent quand la position les franchit **en lecture normale** — jamais sur un saut (scrub, SPP), pour ne pas rejouer une rafale — et figurent sur la timeline et dans la feuille de conduite.
- **Tempo depuis l'audio** (v1, éditeur de chant, « Tempo depuis un fichier audio ») : le navigateur décode l'enregistrement du chant (tout format qu'il sait lire), le ramène à un canal à 22 050 Hz, analyse ses deux premières minutes et propose le BPM (`web/src/audio/tempo.ts` : enveloppe des attaques, autocorrélation de 60 à 200 BPM pondérée vers 120, puis droite passant par les attaques alignées sur les temps : au dixième de BPM sur une piste de clics, même jouée à ±10 ms), avec ×2 et ÷2 contre l'erreur d'octave et un indice de netteté ; le fichier ne quitte pas l'appareil.
- **Sections depuis l'audio** (v1, même analyse) : le premier temps trouvé, le chant entier est découpé en mesures, chacune décrite par son volume et sa brillance ; une frontière là où les quatre mesures d'après diffèrent le plus des quatre d'avant (au moins quatre mesures entre deux), d'où une ébauche « 8 + 16 + 8 mesures » ; « Utiliser ces sections » les pose dans le chant (« Partie 1, 2… », looks à choisir), après confirmation s'il en avait déjà (`web/src/audio/sections.ts`). Une ébauche à vérifier à l'oreille : un refrain qui garde le volume du couplet ne se voit pas.
- **Lecture sans DAW** (v1, `song.play` / `song.stop`, ▶ ■ sur la page Chants) : le chant tourne sur son propre tempo depuis une section ou une mesure, les sections et les actions s'enchaînent seules, arrêt à la fin du chant. Une horloge MIDI qui joue garde toujours la priorité.

### Setlist
- Liste ordonnée de chants avec suivant et précédent (MIDI, OSC), sélection par Program Change ou par le canal réservé.
- Le chant courant est publié sur `light:song`.
- Éditeur de setlist (v1) : nom, ajout de chants, ordre.

### Exports
- **Feuille de conduite** (Markdown/PDF) : par chant, les sections, le bouton et la note, le repère, la tonalité, le BPM, l'arc d'énergie et les sécurités.
- **Planche** (SVG/PDF) : storyboard d'un chant (X = canevas, Y = temps, avec montée, maintien et descente) et plan de la salle par section.
  - v1 (`export.board`, bouton ▤ de la page Chants, `light export board`) : une bande par section (hauteur selon sa durée), les premiers pas de son look en couleurs sur les cellules du canevas, cadence et attaque, repère, actions de la timeline ; SVG imprimable ou convertible en PDF. Plus tard : plan de la salle par section.
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
- **Libellés** : chaque ambiance porte une clé (`intimite`, ce qu'échangent `look.from_intent` et le tag `ambiance:<clé>`) et un `label` facultatif accentué (« Intimité ») que l'interface affiche, à défaut la clé. **La clé** est donnée par une seule fonction (`normalizeMood`) : sans casse ni accents, chaque suite d'espaces ou de ponctuation devient « - » (« Lever de rideau » → `lever-de-rideau`, « joie ! » → `joie`) ; elle sert aux clés de toutes les couches comme aux mots de `song.mood` et des tags `ambiance:`, qui retrouvent ainsi la même intention.
- **Création par intention (page Show, T14)** : un sélecteur à choix multiples avec recherche (sans casse ni accents, par libellé ou clé) liste les thématiques connues avec leurs couleurs et leur famille (et, pour une intention de l'utilisateur, son origine : « ce show », « personnelle ») ; les choisies sont des puces retirables. Un mot libre reste permis (« Ajouter « mot » » quand aucune thématique ne correspond) : envoyé tel quel dans `mood`, il est signalé dans `unknownMoods`.
- **Intentions de l'utilisateur (T15)** : une intention (une ambiance : libellé, 1 à 6 couleurs `#rrggbb` dont la première domine, énergie, famille, notes) se crée, se modifie et se supprime depuis la page Show (section « Intentions »), ou par les commandes `intention.put {intention, scope}`, `intention.delete {id, force?}` et `intention.preview` (proposition de `look.from_intent` pour une intention non enregistrée, avec le contraste ΔE de ses deux premières couleurs et `lowContrast` sous 25). Libellé de 80 caractères au plus (clé de 64), famille de 40, notes de 2000.
  - **Où elle vit, au choix à la création** : dans le **show** (`scope: "show"`, collection `intentions` du dossier du show : elle voyage dans ses `.lightshow` et ses sauvegardes, suit l'ouverture d'un autre show, la réinitialisation et les propositions `show.diff`/`show.propose`) ou dans la **bibliothèque personnelle** (`scope: "personal"`, `data/private/intentions/`, partagée par tous les shows de la machine ; son historique est élagué comme celui des shows).
  - **Ce que l'archive emporte** (décision du 2026-11-11) : un `.lightshow` du show embarque, en plus de ses intentions, une **copie** des intentions de la bibliothèque personnelle et du fichier privé que ses chants (ambiance) et ses looks (tag `ambiance:`) citent, rangées comme **intentions du show** au moment de l'emballage (le dossier du show ne change pas), et le manifeste les nomme (`intentions`). Ce n'est pas une fuite : c'est ce que le show utilise. Les intentions de la machine que le show ne cite pas restent sur la machine. **À la restauration** (décision du 2026-11-11, « on ne les recopie pas ») : celles que la machine a **à l'identique** (même clé, même contenu) ne sont **pas recopiées** dans le show, qui continue d'utiliser celles de la bibliothèque ; les autres (autre machine, ou contenu changé depuis) arrivent comme intentions du show. L'aperçu le dit (« n intention(s) déjà dans ta bibliothèque, non recopiées »).
  - **Origine visible partout** : liste des intentions (puce), sélecteur de « Créer par intention », éditeur de chant (sous les ambiances) et éditeur de look (sous les tags `ambiance:`) disent pour chaque intention si elle vient du show, de la bibliothèque de la machine (personnelle ou fichier privé), de la base livrée, ou si elle est inconnue ici.
  - **Vers la bibliothèque** : une intention du show propose « **Ajouter à ma bibliothèque** » (copie dans la bibliothèque personnelle, remplace celle de même clé après confirmation) ; puis, sur un second oui, la copie du show est retirée et le show utilise celle de la bibliothèque (Annuler : le show garde sa copie, qui reste sa retouche).
  - **Gérer la bibliothèque** (page Fichiers, section « Ma bibliothèque d'intentions », indépendante du show ouvert) : ajouter, modifier, supprimer les intentions personnelles, et voir pour chacune les shows de la machine qui la citent sans en avoir leur propre copie (`intention.library` ; `intention.delete` avec `scope: "personal"` supprime celle de la bibliothèque même si le show ouvert a une copie de cette clé). Même composant que la section du show.
  - **Liaisons par id (à venir, T15b)** : aujourd'hui un chant (`mood`) et un look (tag `ambiance:`) citent une intention par sa clé, tirée du libellé. Décidé le 2026-11-11 : de **vrais ids générés** (une nouvelle intention reçoit un id ; les existantes gardent leur clé comme id ; retouche, masque, copie dans le show et ajout à la bibliothèque gardent l'id d'origine ; le libellé devient renommable ; une entrée du fichier privé garde un id tiré de son mot-clé). Chantier à part, plan dans [todo.md](../todo.md) T15b.
  - **Précédence**, clé par clé, la plus spécifique gagne : **show > bibliothèque personnelle > fichier privé** (`data/private/knowledge.json`, édité à la main, lu une fois au démarrage) **> base livrée**. Une intention du show dont la clé existe plus bas en est une **retouche** pour ce show. Les couches du show et de la bibliothèque sont relues à chaque appel : une modification se voit aussitôt, sans redémarrer. `knowledge.get` donne pour chaque intention son **origine** (`generic`, `private`, `personal`, `show`), ce qu'elle remplace (`over`) et ce qui l'emploie dans le show (`usedBy` : chants par leur ambiance, looks par leur tag `ambiance:`), plus la liste `hidden` des intentions masquées.
  - **Clé** : un mot sans lettre ni chiffre a la clé vide, qui ne nomme rien (ignorée partout) ; les ligatures s'écrivent en toutes lettres (œ → oe, æ → ae, ß → ss, ø → o). Deux mots du fichier privé qui donnent la même clé : seul le dernier compte, « Vérifier le show » le signale, comme un fichier d'intention refusé par le schéma (clé invalide…).
  - **Création** : sans `id`, la clé vient du libellé ; elle est refusée si cet endroit a déjà cette clé (`detail.exists`, l'interface le dit avant l'envoi) ; une clé de la base livrée ou du fichier privé n'est pas prise : l'interface dit que la nouvelle la **remplacera** (pour ce show, ou pour tous les shows depuis la bibliothèque). **Modification** : avec `id`, la clé est gardée ; **elle ne se renomme jamais** (chants et tags la citent), seul le libellé change.
  - **Supprimer** : une intention du show ou de la bibliothèque disparaît ; si elle retouchait une intention plus bas, celle-ci revient (« Revenir à l'original »). Une intention **livrée** ou du fichier privé n'est pas supprimée : elle est **masquée pour ce show** (une entrée cachée du show, réversible par « Rétablir »). Un retrait qui laisserait des chants ou des looks du show citer une intention inconnue est **refusé sans `force`**, avec le nom de ce qui l'emploie (`show.references` accepte le genre `intention`). Pour une intention de la **bibliothèque personnelle** sans rien dessous, les **autres shows** de la machine qui la citent (sans copie à eux) font partie des usages, dans la même question et le même refus (`detail.otherShows`). Les versions d'une intention du show passent par « Versions » (`history.list`/`history.restore`, collection `intentions`) ; un masque remis par une version ou par l'annulation d'une proposition reste un masque (`intention.put` accepte `hidden: true` dans le show, sur une clé connue plus bas).
  - **Partage entre shows** : par l'archive ou par la bibliothèque personnelle ; pas d'export d'intentions seules. « **Copier dans le show** » fait d'une intention personnelle (ou du fichier privé) une intention du show, pour la retoucher pour lui seul. « Vérifier le show » signale un chant qui cite une intention inconnue ou masquée, et dit (information) qu'une intention citée vient de la machine et que les sauvegardes en emportent une copie.
  - **Préréglages automatiques** : `show.autopresets` lit la base fusionnée du show : retoucher « joie » change les couleurs de sa palette, une intention masquée retombe sur les couleurs de repli intégrées.

## Notes partout
- Champ `notes` (Markdown court, horodaté) sur **chaque objet** : fixture, zone, groupe, look, preset, palette, section, cue, mapping, dashboard, widget, node, univers.
- **Annotations libres** : post-it sur la scène, commentaires à un temps donné sur la timeline.
- Une icône ✎ apparaît sur tout objet annoté. La page **Notes** offre une recherche globale. Les notes sont incluses dans les ressources MCP et accessibles par `light_note_*`.

## Import QLC+ puis reconstruction
1. **Import `.qxw`** :
   - fixtures (avec `.qxf`), groupes ;
   - fonctions Scene, Sequence (SpeedModes Common/PerStep, FadeIn/Hold/FadeOut, RunOrder dont Random), Chaser, RGBMatrix, Collection ;
   - Virtual Console : SoloFrame, Button et Slider avec leurs `<Input>` MIDI, SpeedDial avec les multiplicateurs par fonction ;
   - le profil d'entrée `.qxi` sert à retrouver les noms ;
   - **Faders** (v1) : un fader « Level » sur les gradateurs de projecteurs à couleurs → DCA ; sur d'autres canaux (blanc, UV, strobe, machines, lampe sans couleur comme le gradateur générique, ou projecteur sans définition) → **fader de canaux** ; un fader **Submaster** → DCA qui dose ce que contient son cadre (et les sous-cadres) : les looks lancés par ses boutons, les DCA (en sous-groupes) et les faders de canaux issus de ses faders « Level » ; un fader **Playback** → **DCA playback** qui dose le look de sa fonction et le lance au-dessus de 0 (l'arrête à 0) ; seuls les faders en mode Level donnent des faders de canaux (QLC+ garde les canaux d'un fader passé en Playback ou Submaster) ; leurs CC MIDI sont repris ;
   - **Scenes lancées par un bouton ou un fader** → look d'un seul pas (son fondu d'entrée devient celui du look) ; les Scenes qui ne servent que de support à une séquence sont ignorées ; les **RGBMatrix** lancées par un widget → look sur un **canevas du groupe de fixtures** de la matrice (têtes colonne par colonne), avec la technique la plus proche : Plain → plat, Alternate → damier, Stripes et Gradient → palette qui tourne, Plasma → palette en fondu, Flying Objects → masques (un objet qui court) ; toute approximation est signalée dans le rapport ;
   - **Séquences sans couleur** (machines, lampes) → look `aucune` à **canaux bruts** : chaque canal écrit par la séquence, un pas par pas de QLC+ (les zéros que QLC+ n'enregistre pas sont rétablis) ; séquences vides signalées ;
   - **Modes** : un mode absent de la définition (« Standard » contre « 2ch ») est remplacé par le seul mode qui a le même nombre de canaux (signalé) ;
   - **EFX** (mouvements de lyres, v1) → look de position (technique `aucune`) dont le Move FX anime un groupe de ses projecteurs : cercle, huit, lignes ; carré, losange, feuille et Lissajous **approximés par un cercle** (signalé) ; durée → cycle en secondes, Offset/Width/Height → centre et taille, `Serial` → têtes réparties sur un cycle, `Backward` → inversé ; parties gradateur ou RGB d'un EFX non converties (signalé). Format lu d'après le code de QLC+ (`efx.cpp`) : **à valider sur un vrai workspace contenant des EFX**.
2. **Analyse** : extraction des palettes récurrentes, des structures de séquences, des notes MIDI (vers le registre) et des conventions de nommage.
3. **Reconstruction** : chaque séquence est reconvertie, quand c'est possible, en **technique paramétrique** sur un canevas (damier, palette qui tourne, masques, orage…). Elle devient éditable et portable. Ce qui ne se reconnaît pas reste une séquence à pas importée telle quelle.
4. Tout passe par une **proposition** (diff) avant d'être appliqué. En **mode hybride** (v1), une réimportation conserve ce qui a été ajusté à la main :
   - l'import mémorise l'empreinte de ce qu'il a écrit (`import-state.json` du show) ; un objet **inchangé depuis** est mis à jour avec la nouvelle version QLC+, un objet **modifié à la main est conservé** et signalé ;
   - toujours conservés : position, montage, orientation, rôle et notes des projecteurs ; niveau, mute et limites des DCA ; niveau des faders de canaux ;
   - objets importés avant ce suivi et différents : conservés et listés « à vérifier » ; `replace` (CLI `--replace`) écrase volontairement les retouches (l'état en direct et les champs utilisateur restent) ;
   - un mapping importé n'est jamais posé sur une entrée MIDI déjà tenue par un mapping fait à la main : celui de l'utilisateur reste, l'autre est signalé (« Entrées MIDI en conflit ») ;
   - un **autre workspace** (moins de la moitié des projecteurs du show en commun) est refusé : ses canevas et looks de même nom remplaceraient ceux du show. Il va dans un show à lui ; `force` (CLI `--force`) l'importe quand même ;
   - les définitions `.qxf` déposées dans `data/fixtures/` (ou ajoutées depuis la page Import, `fixture.definition.add`) pendant que le serveur tourne sont relues à l'import, sans redémarrage ;
   - un fichier de même nom au contenu différent est refusé (`CommandError` avec `detail { exists, file }`) ; la page Import propose alors **Remplacer** (confirmation, puis `replace: true`) ; un contenu identique est accepté, `replace: true` sur un fichier absent le crée (T34) ;
   - un workspace s'importe aussi **dans un nouveau show** (`show.create` avec `qxw`), avec son propre lieu : c'est le chemin d'un autre workspace.

## Tests
- Palettes par référence et détachement.
- Instanciation de presets, presets automatiques sur un canevas.
- Sérialisation aller-retour de tous les types (SoundSwitch perdait des données de presets).
- Timeline suivie par une clock simulée et SPP.
- Grille : section hors famille signalée.
- Import d'un `.qxw` d'exemple neutre, reconstruction reconnue sur les techniques connues, mode hybride.
