# Retour d'expérience : la méthode actuelle de l'utilisateur (QLC+ + Ableton)

Analyse, en lecture seule, de l'espace de travail lumière de l'utilisateur (privé, **hors dépôt**). Il contient des workspaces QLC+ générés par scripts, des racks Ableton générés, une banque de tests MIDI de bout en bout et une documentation de méthode.

> **Confidentialité** : ce document ne reprend **aucun** nom de lieu, d'événement, de chant ni de personne, et aucune adresse réseau. Il ne garde que les **mécanismes** et les **leçons**. Le chemin de l'espace de travail n'est pas noté ici.

## Vue d'ensemble de la méthode actuelle
- **Matériel type** : barres LED pixel (8 segments RGBW), PAR LED, machine à bulles et fumée, hazer, machine à fumée. Dans une autre salle : barres, spots, découpes, une trentaine d'appareils.
- **Tout est généré par scripts** (Python stdlib) : les `.qxw`, les racks Ableton, le profil d'entrée MIDI, des planches de relecture SVG. `make` est **idempotent** (deux passes ne produisent aucun diff) et `make check` valide tout hors ligne.
- **Ableton est le maître** : clips de notes MIDI vers QLC+ via un bus MIDI virtuel, horloge MIDI de Live pour le tempo, **AbleSet** pour la setlist (repères = chants, piste « Sections » = sections, automation de tempo).
- **Ampleur** : des centaines de fonctions par show (scènes, séquences, matrices), une centaine de boutons, environ 25 faders, un seul cadre « solo » pour les scènes. Environ 200 notes et 18 CC sont vérifiés de bout en bout.

---

## 1. Déclenchement depuis Ableton : ce qui marche, et les pièges

| Constat | Conséquence pour light-mcp-server |
|---|---|
| L'utilisateur veut **voir dans Ableton le nom de l'effet** qu'une note déclenche | Export d'un **MIDI Effect Rack** (et non d'un Drum Rack) : **une chaîne par action, nommée comme elle, avec une key zone d'une seule touche**, une couleur par bande et **le rouge pour les actions dangereuses**. La légende des CC passe dans l'`Annotation` du device, et le `UserName` rappelle le canal |
| Le XML Live n'est **jamais fabriqué à la main** : on clone une branche d'un **export réel non modifié** (« coquille ») et seuls `Name`, `DocumentColorIndex` et `KeyRange` sont changés | Notre exporteur part d'une **coquille fournie par l'utilisateur** (sa version de Live), clone `<MidiEffectBranchPreset>` et vérifie que le reste ressort octet pour octet |
| **Un rack = une piste** : une note dans deux key zones est **dupliquée**, et avec des boutons en *Toggle* deux Note On s'annulent | Avertissement dans l'export, et surtout un mode de déclenchement **idempotent** (voir §2) qui rend la duplication inoffensive |
| **Notes épinglées** (`notes.json`) : une note déjà posée dans un set Live ne change **jamais** de sens. Une note libérée reste **réservée**, et une collision **bloque** la génération pour qu'un humain arbitre | **Registre de notes épinglées** dans le show, avec réservations. Toute réattribution passe par une proposition explicite, jamais en silence |
| **Bandes de notes** par événement, et une **bande commune** (palettes) identique dans tous les shows, ce qui permet un rack partagé | Bandes de notes configurables par show, avec une bande « bibliothèque commune » stable d'un show à l'autre |
| Tout sur le **canal MIDI 1**, car le filtrage par canal de QLC+ dépend d'un réglage machine perdu à la réinstallation | Chez nous le canal fait partie du mapping, stocké dans le show (et non dans la config machine) |
| La **numérotation interne** de QLC+ a été fausse deux fois avant d'être relevée dans le code source | Mapping exprimé en termes MIDI natifs (type, canal, numéro), jamais en offsets opaques |
| **Retour d'info renvoyé sur le bus d'entrée** : QLC+ renvoie l'état de ses boutons sur le bus d'où viennent les notes, et ses *Toggle* basculent tout seuls | Le retour MIDI va **toujours sur un port distinct** de l'entrée. On **détecte les boucles** et on refuse un port de sortie identique au port d'entrée |
| Les **flashs** se tiennent : la note doit être **tenue**, et sa longueur dans le clip fait la durée | Confirme le mode **Continu** (actif tant que la note est tenue) |
| Après une prévisualisation en *scrub* au milieu d'une section, la scène ne se rallumait pas (une note-déclic d'un temps). Corrigé par **un clip autonome par section** | Côté serveur, on suit la **position** (SPP) et on rétablit la section courante, au lieu de dépendre d'une note ponctuelle |

## 2. Sémantique des boutons
- Le *Toggle* de QLC+ est un piège : **rejouer la même note arrête** la section.
- L'exclusivité (*SoloFrame*) n'est radio **qu'à l'intérieur d'un cadre**. Deux cadres côte à côte laissaient deux scènes allumées sur les mêmes projecteurs. Il a fallu tout regrouper dans **un seul** cadre solo.

→ **Nouveau mode « Déclencher » (idempotent)** : une note on **active toujours** et ne désactive jamais. C'est la sortie d'un **groupe d'exclusivité** qui relâche le précédent. C'est le mode par défaut recommandé pour les sections de chant.
→ Les **groupes d'exclusivité** sont indépendants de la disposition de l'UI. Ils sont définis par **les projecteurs disputés** : le serveur **détecte les conflits** (deux looks actifs qui écrivent les mêmes attributs des mêmes fixtures) et les signale.

## 3. Tempo : le « contrat »
- Les séquences sont écrites sur une **grille neutre à 60 BPM** (1 pas = 1 temps). Une molette de vitesse, alimentée par l'horloge MIDI d'Ableton, les recale au tempo réel, avec des **multiplicateurs par fonction**.
- **Piège majeur** : une sauvegarde depuis l'interface de QLC+ **fige le dernier tempo joué** dans toutes les fonctions.
- **Profils de cadence** :

  | Profil | Cadence | Fondu | Usage |
  |---|---|---|---|
  | ×2 | un pas tous les 2 temps | — | couplets calmes |
  | ×1 « respire » | un pas par temps | fondu = durée | — |
  | ×1 « claque » | un pas par temps | fondu ≈ 0 | refrains |

  La brume et les flashs restent **hors tempo**.

→ Nos **durées musicales** couvrent ce besoin nativement. Le tempo d'exécution **n'est jamais persisté** dans les définitions.
→ On ajoute un **profil de cadence** nommé par effet : multiple de temps, et **rapport fondu/durée**.

## 4. Ce qui fait « claquer » une section : le rapport fondu / durée
C'est la découverte clé de la méthode. Avec un `FadeIn ≈ Duration`, l'image respire en permanence. Avec un `FadeIn ≈ 0` et le reste en maintien, l'image **saute puis tient** : l'œil voit un bord franc, sans strobe.
→ On ajoute un paramètre de premier plan **« attaque »** (0 % = coupe franche, 100 % = fondu continu) sur tous les effets à pas et chasers, avec les presets « respire » et « claque ».

## 5. Bibliothèque de techniques (à intégrer comme presets paramétrables)
Elles sont définies sur un **canevas abstrait** (voir §7) et non sur des canaux.

| Technique | Principe | Paramètres |
|---|---|---|
| **Damier** | dominante et accent répartis sur deux groupes qui **échangent** à chaque pas | 2 couleurs, groupes A et B |
| **Palette qui tourne** | chaque bloc prend une teinte décalée d'un cran à chaque pas ; **rien ne s'éteint** | au moins 3 teintes, miroir depuis le centre |
| **Creux qui tourne** | un trou qui se déplace | largeur, sens |
| **Masques ON/OFF** | jeu de masques variés (bords, cœur, extérieurs…) joués en aléatoire, pour **casser la régularité** | liste de masques |
| **Masques colorés** | idem avec des couleurs | masques et palette |
| **Respiration** | nappe qui ondule lentement | durée en mesures |
| **Plat** | une couleur fixe | — |
| **Lights partiels** | seule une partie du rig est allumée | sélection |
| **Orage probabiliste** | **réservoir pondéré** de pas « calmes » et de pas « éclair » (un seul projecteur, 25 ms) tirés en aléatoire, avec des maintiens par pas volontairement irréguliers. Le ratio calme/éclair règle la fréquence | ratio, couleurs, maintiens |
| **Flamme** | scintillement aléatoire ambre/or, maintiens très courts | teintes, vitesse |
| **Flash maison** | pas blancs de 25 ms, **substitut du strobe** sans toucher au canal strobe | couleur, durée |

**Ordres de lecture** : Loop, Random, PingPong, plus **aléatoire pondéré**. On peut aussi mélanger **timing commun ou par pas**.

## 6. Méthode de conception d'un chant (à outiller dans l'UI et le MCP)
1. Résumer l'**ambiance globale** en 1 ou 2 mots-clés : c'est le garde-fou de toutes les sections.
2. **Découper** en sections selon la musique **et** la progression du texte.
3. Pour chaque section, choisir une **dominante et un accent** raccord avec l'ambiance et contrastés avec la section voisine. Sinon, ne pas changer.
4. Traduire l'énergie en paramètres :

   | Énergie | Nombre de pas | Cadence |
   |---|---|---|
   | posé | 1–3 | ½ temps à 1 mesure par pas |
   | dynamique | 6–9 | 1 temps par pas |
   | survolté | 12+ | 1 temps par pas, Random ou PingPong |

   Chaque section commence par un **pas 0 de fondu d'entrée**.
5. **Récit** : si le texte raconte un passage (ombre vers lumière), faire évoluer la nappe elle-même (couleur, fréquence des événements).

**Règle d'or** : une section ne change de couleur que si son idée-clé a changé.

→ On ajoute une **grille de chant** (section → idée-clé → ambiance → dominante/accent → énergie → transition) dans l'éditeur de chant, ainsi qu'un outil MCP qui la remplit à partir des paroles ou de la structure.

## 7. Le canevas abstrait et le rendu sur un autre kit
- Les moteurs calculent un **mur de 32 cellules** (4 barres × 8 segments) avec une composition **en miroir**. Pour un autre show, ils calculent un **anneau** (barres disposées en carré).
- Pour une autre salle, **le même mur est « rendu » sur le kit local** : chaque bloc de 4 cellules est attribué à un appareil, et le miroir reste symétrique.

→ **Concept central à ajouter** : des **canevas** (ligne, ligne miroir, anneau, grille) sur lesquels on écrit les effets, et un **mappage canevas → fixtures par lieu**. Un show devient **portable d'une salle à l'autre** sans être réécrit.

## 8. Intensité, sécurité et règles
- **Aucune scène n'écrit d'intensité.** Les scènes portent la couleur et les effets ; le niveau se règle aux **faders/masters**, parce qu'il dépend de la salle du soir. Corollaire : fader en bas, rien ne s'allume. → Option « scènes sans intensité » au niveau du show, et validation par nos masters façon DCA.
- **Pas de strobe** (public jeune, photosensibilité). Le canal strobe n'est écrit **que** par un fader dédié, et les flashs sont des pas de couleur, pas du strobe. → Règle de show : `strobe` interdit à toutes les sources sauf un fader désigné.
- **Sections d'« appel »** : jamais automatisées, **sol jamais noir**, seules les techniques sans coupure sont admises (la palette qui tourne). → Drapeaux de section `manualOnly` et `noCut`, avec une règle d'**intensité plancher**.
- **Actions dangereuses** (flashs, strobe) : elles restent mappées, mais **marquées en rouge**, et poser le clip reste un choix humain. → Marqueurs « danger » propagés dans l'UI et l'export Ableton.
- **Machines** : brume en continu et **jamais au tempo** ; bulles interdites pendant certains moments (prise de parole, prière, personnes au sol) ; fumée « pleine puissance » dosée par un submaster. → Règles par section sur les machines.
- **Particularité de fixture** : une barre reste **noire tant qu'un canal « strobing » est sous 32**. → Exemple type de règle au niveau du type de fixture (valeur minimale imposée).
- **Panic** = un blackout dédié, le seul qui écrive le canal strobe.
- **Pièges HTP** :
  - un submaster de cadre ramenait les flashs à 35,7 % ;
  - le mélange HTP impose un « lit » plus sombre que le flash sur chaque canal.

  → Option par flash : **ignorer les sub-masters** et passer en priorité (LTP) le temps du flash.

## 9. Séparer le show, la machine et le lieu
- La sortie Art-Net (IP) et la ligne MIDI changent selon le jour et la machine. QLC+ les **réécrit** dans le show à la sauvegarde. Les générateurs devaient donc **préserver les réglages faits sur place** (IP, entrées, valeurs de faders) et **refuser d'écraser** toute autre modification manuelle (« rien n'est écrit », liste de ce qui serait perdu).
- Les mêmes adresses DMX servent dans tous les shows d'un même kit : **aucun repatch** d'un show à l'autre.

→ Trois couches distinctes : **config machine** (interfaces, ports), **lieu** (patch, stage, canevas, règles du lieu) et **show** (looks, chants, mappings). Un show se charge sur un lieu.
→ Les modifications manuelles sont **protégées** : une régénération par l'IA passe par une proposition avec diff (déjà prévu) et un **mode hybride** qui conserve ce qui a été ajusté à la main.

## 10. Relecture et vérification
- **Planches de relecture** (SVG) :
  - par séquence : X = le mur, Y = le temps, avec montée, maintien et descente ;
  - par section : quelques échantillons du mur, l'énergie, les fondus, l'intention ;
  - sur une **vue en plan** de la salle.

  → **Vue « planche »** dans l'UI (storyboard d'un chant), avec export SVG/PDF pour les répétitions.
- **Contrôles automatiques** : contraste ΔE des couples de couleurs, symétrie des miroirs, sections identiques ou inertes, scènes qui écriraient un variateur, un strobe ou un UV, conflits de notes. → Outil **`light_lint`** dans le MCP et l'UI.
- **Banc de test réel** : injection des notes et CC, lecture du DMX, **mesure de la cadence**, vérification de l'exclusivité. → **Auto-test intégré** (`light_selftest`) qui balaie tous les mappings et vérifie l'état et le DMX résultants.
- **Feuilles de conduite** : pour chaque chant, le bouton, le **repère structurel** (« l'entrée franche du groupe », pas un horaire), la tonalité, le BPM mesuré et l'arc d'énergie. → **Export « conduite »** depuis les chants (Markdown/PDF).

## 11. Base de connaissances couleur
L'utilisateur a constitué :
- les **8 axes d'une ambiance** (intensité, température, saturation, direction, diffusion, mouvement, texture, rythme) et un catalogue d'ambiances nommées ;
- une **table sentiments → couleurs** (environ 110 mots-clés groupés par famille, 1 ou 2 couleurs, niveau et mouvement, avec un journal des combinaisons éprouvées) ;
- une psychologie des couleurs, avec la règle « **la couleur ne touche jamais la peau** » (le blanc des visages est séparé) ;
- un **journal chant → ambiance → palette** par événement.

→ `light_look_from_intent` et l'assistant de chant s'appuient sur une **base de connaissances** :
- un format générique est livré dans le dépôt ;
- le contenu de l'utilisateur est chargé depuis un **plugin ou dossier privé**.

On ajoute aussi l'**axe « intention »** (les 8 axes) aux looks.

## 12. Analyse audio
Un script extrait **BPM, arc d'énergie et frontières de sections** d'un morceau pour caler les repères. Ses limites sont documentées. → Plugin optionnel « analyse audio » qui propose une structure de chant (jamais appliquée sans validation).

## 13. AbleSet
- **Lecture** par HTTP : setlist, état, transport.
- **Écriture** par OSC : sauts de chant ou de section et surtout **injection MIDI** (`/midi/send/...`). C'est ce qui rend le banc de test possible.
- Le show Live est **généré** : repères par chant, clips de section, clips de notes, paliers de tempo, avec des règles d'espacement et un mode hybride.

→ Notre **connecteur OSC** pour AbleSet peut servir dans les deux sens :
- recevoir le chant et la section courants ;
- injecter des notes de test.

→ Un **générateur de Live Set** (setlist → repères, sections, clips) est un candidat **plugin**.
