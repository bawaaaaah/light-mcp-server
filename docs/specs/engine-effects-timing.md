# Moteur, effets et timing

## Périmètre
| v1 | Plus tard |
|---|---|
| Pipeline complet, programmer, looks, techniques à pas, effets par forme d'onde, cue stacks, easing, durées fixes ou musicales, MIDI clock | Ableton Link, OS2L, synchronisation audio (plugin) |
| Bibliothèque de techniques sur canevas, attaque, profils de cadence | RGB Matrix avancée (texte, vidéo) |

## Pipeline (tick ≈ 44 Hz, horloge injectable)
En plus des ticks réguliers, **toute commande qui change l'état demande un rendu immédiat** (`requestFrame`, espacement minimal de 4 ms). Sans cela, un déclenchement attend jusqu'à 22,7 ms. Le prototype P2 mesure 3,5 ms au pire avec le rendu immédiat ([proto-resultats](../research/proto-resultats.md)).

1. **Sources** :
   - **programmer** (priorité max ; on peut forcer un canal depuis la console DMX) ;
   - **playbacks** actifs (looks, techniques, effets, cue stacks, collections, matrices), chacun avec un niveau et une priorité ;
   - **valeurs par défaut** des fixtures.
2. **Fusion** : HTP pour l'intensité, LTP horodaté pour le reste, priorité par playback. Les effets sont **absolus** ou **relatifs** (ajoutés à la base).
3. **Groupes** : masters proportionnels en cascade jusqu'au grand master, mute, flash, limites ([groups-masters](groups-masters.md)).
4. **Blackout, freeze, flash.** Un flash peut **ignorer les masters** et passer en priorité LTP le temps du flash. Piège relevé : un master ramenait les flashs à 35 %, et le HTP imposait un lit plus sombre.
5. **Masque de règles** : la dernière étape, que personne ne contourne ([rules-limits](rules-limits.md)).
6. **Conversion** attribut → DMX (coarse/fine, inversions), puis buffers d'univers, puis sortie.

Le **tempo d'exécution n'est jamais persisté** dans les définitions. QLC+ figeait le dernier tempo joué à la sauvegarde.

## Fonctions
- **Look** : couleurs et effets pour un ensemble de fixtures ou un canevas. **Sans intensité par défaut** ([rules-limits](rules-limits.md)).
- **Technique** : effet **à pas** écrit sur un canevas (voir plus bas).
- **Effet par forme d'onde** (voir plus bas).
- **Cue stack** :
  - pas avec fade in, fade out, hold, delay et easing par pas et par attribut ;
  - **tracking** (une valeur reste tant qu'un cue ne la change pas) et **release** d'attributs (Onyx) ;
  - commandes GO, BACK, PAUSE et saut.
- **Collection** : lance plusieurs fonctions ensemble.
- **Matrice** : motifs pixel (plasma, fire, bars, gradient) sur un canevas grille.

Les fonctions restent **paramétriques** : elles ne sont jamais « cuites » en chaser, contrairement à Daslight, et restent éditables pendant qu'elles jouent. Elles peuvent agir sur **n'importe quel attribut** (zoom, gobo, iris, pan…), pas seulement RGB et dimmer.

## Modèle à pas (techniques)
- Une suite de **pas**. Chaque pas donne un état du canevas (couleurs, masque, valeurs absolues ou relatives).
- **Attaque** : le rapport fondu/durée d'un pas, de 0 à 100 %.
  - **« Claque »** (≈ 0 %) : bord franc puis maintien. C'est ce qui rend une section nerveuse **sans strobe**.
  - **« Respire »** (100 %) : fondu continu.
- **Width** façon grandMA3 : la durée de transition en % de temps (0 % = saut, 100 % = un temps, 200 % = deux temps).
- **Cadence** :
  - durée commune ou **par pas** (mélange voulu de maintiens, par exemple pour la pluie ou l'orage) ;
  - **profils de cadence** nommés : multiple de temps (×½, ×1, ×2, 1 mesure) + attaque ;
  - les machines (brume) et les flashs sont marqués **hors tempo**.
- **Ordres** : Loop, PingPong, Random, **aléatoire pondéré** (un réservoir de pas avec poids, base de l'orage probabiliste).
- **Aléatoire sur les choix** (v1), comme l'ordre Random des pas : la **palette** peut tirer la couleur de chaque bloc au hasard (`random`) ; l'**onde** et le **Move FX** peuvent distribuer leur décalage dans un **ordre mélangé** (`shuffle`, le « shuffle » de grandMA3) plutôt que le long du canevas ; le Move FX a une forme **`aleatoire`**. Tout tirage est **déterministe** (graine tirée du look) : un look rejoue toujours de la même façon, comme l'ordre Random, et la répétition ou l'auto-test restent reproductibles.
- **Pas 0 d'entrée** : fondu d'arrivée optionnel, quelle que soit la cadence ensuite.
- **Boucle de N mesures** (SoundSwitch) : repart toujours sur le premier temps de la mesure.

### Bibliothèque de techniques (presets paramétrables, v1)
| Technique | Principe |
|---|---|
| Damier | dominante et accent qui **échangent** entre deux groupes à chaque pas |
| Palette qui tourne | chaque bloc prend une teinte décalée d'un cran ; rien ne s'éteint ; au moins 3 teintes ; miroir depuis le centre. **Tirage au hasard** (`random`) : à chaque pas, chaque bloc tire une teinte de la palette, jamais celle qu'il a (16 pas, à combiner avec l'ordre Random) |
| Creux qui tourne | un trou qui se déplace |
| Masques ON/OFF | jeu de masques variés en aléatoire, pour casser la régularité |
| Masques colorés | idem, avec des couleurs |
| Respiration | nappe lente |
| Plat | une couleur fixe |
| Lights partiels | une partie du rig seulement |
| Orage probabiliste | réservoir pondéré de pas calmes et de pas éclair (un projecteur, 25 ms) ; le ratio règle la fréquence |
| Flamme | scintillement aléatoire chaud, maintiens très courts |
| Flash maison | pas blancs courts, **substitut du strobe** sans toucher au canal strobe |

**Préréglages façon Wolfmix** : Colour FX (rainbow, sparkle, fever), Move FX (pan, tilt, circle, figure‑8, magic carpet) et Beam FX (chase, wave, heartbeat). Ils sont construits sur ces deux modèles, avec **deux couches A et B combinables** par module.

### Move FX (lyres, v1)
- Un look peut porter un **`move`** en plus de sa technique de couleur ; la technique `aucune` donne un look de position pure (preset de position, mouvement seul).
- Formes : `fixe` (position), `cercle`, `huit`, `pan`, `tilt`, `tapis` (« magic carpet » : vague de tilt, spread 1 par défaut), **`aleatoire`** (chaque lyre glisse vers un nouveau point tiré dans la boîte centre ± taille à chaque cycle, en accélérant puis en freinant ; avec `wings`, les deux lyres d'une paire symétrique partagent leurs points).
- Paramètres : centre et taille (fractions de la course), un cycle par `every` (temps ou secondes, comme la cadence), **spread** (déphasage du premier au dernier projecteur, en cycles), `wings`, `reverse`, **ordre mélangé** (`shuffle` : le déphasage suit un ordre tiré au hasard, toujours le même pour un nombre de lyres donné), **éventail** (`fan`, écart de pan fixe le long de la rangée).
- Projecteurs déplacés : les lyres du canevas du look, dans l'ordre des cellules, ou celles d'un **groupe** (`move.group`), triées par X.
- Une **position manuelle** (pad XY, viser) passe devant les looks jusqu'au relâchement ; le Panic neutre relâche tout.

### Fondu d'entrée
- `timing.entryFade` (secondes) : au lancement, le look part du **noir** sur les cellules qu'il peint et y arrive en fondu ; c'est le « pas 0 d'entrée » et le fondu d'entrée d'une Scene QLC+. L'auto-test de cadence attend la fin du fondu avant de mesurer.

### Canaux bruts (machines, lampes, v1)
- Un look peut porter des **canaux bruts** (`channels`) : des canaux hors canevas (fumée, hazer, ventilateur, lampe sans couleur), donnés par projecteur + décalage depuis son adresse, donc **même sans définition**, avec une valeur DMX (0-255) par pas.
- Ils avancent avec l'horloge du look (`every`) : dans l'ordre des couleurs quand le nombre de pas est le même, sinon en boucle. **Pas de fondu** (une machine ne se fond pas).
- Ils fixent leurs canaux après la conversion du canevas ; deux looks sur le même canal : le plus haut l'emporte ; les faders de canaux (HTP) puis le **masque de règles** passent après. Ils ne sont pas dosés par les DCA (une vitesse de ventilateur ne se dose pas).
- Avec la technique `aucune`, c'est un **bouton machine** : « Fumée 50 % », « bouffées de hazer toutes les 2 s ».
- **Éditeur** : rubrique « Canaux bruts » de l'éditeur de looks ; un canal se choisit par projecteur puis par nom (ou par numéro sans définition) ; une grille donne la valeur de chaque canal à chaque pas.

## Effets par forme d'onde
- **Formes** : sine, triangle, saw, ramp, square (PWM), random, step, courbe custom (points ou bezier).
- **Paramètres** : vitesse (Hz ou fraction de BPM), taille, offset, **phase et spread** ; répartition en groups, blocks, wings, shuffle (grandMA3) ; direction (avant, arrière, rebond, aléatoire) ; ordre (patch, groupe, canevas, ou spatial selon X/Y/Z/radial) ; fade-in/out de l'effet.

## Exclusivité et conflits
- L'exclusivité est portée par les **groupes exclusifs** ([groups-masters](groups-masters.md)) : un look lancé relâche les autres membres du groupe.
- Le moteur **détecte les conflits** (deux playbacks actifs, hors d'un même groupe exclusif, qui écrivent les mêmes attributs des mêmes fixtures) et les publie sur `light:conflicts`.

## Easing
- Courbes de Penner (in, out, inOut : quad, cubic, quart, quint, sine, expo, circ, back, elastic, bounce), `cubic-bezier` éditable et `steps(n)`.
- S'applique à chaque transition : pas, entrée et sortie de look, cue de timeline.

## Durées et tempo
- `Duration = { mode: "fixed", seconds } | { mode: "musical", beats }`, en fractions (`1/4`) ou en mesures. Le mode se choisit **par élément** et se bascule à tout moment.
- En mode musical, un changement de BPM recalcule les durées à la volée **sans saut de phase**.
- **Horloge** :
  - sources : manuel, tap, **MIDI clock** (PLL, lissage, détection d'arrêt, SPP), **micro** (v1, ci-dessous) ;
  - multiplicateur ×½ ou ×2, signature (4/4 par défaut) ;
  - phase de temps et de mesure partagée par tous les effets ;
  - alerte si une horloge est attendue mais absente ;
  - **deux comptes séparés** : le **temps moteur** (cadence des looks) suit les ticks pendant que le DAW joue, **continue au dernier tempo connu** quand l'horloge s'arrête ou manque (les looks ne se figent jamais entre deux chants) et **ignore les sauts** de position ; la **position du chant** (SPP + ticks), elle, n'existe que pendant la lecture et sert au suivi des sections. Un recul dans l'arrangement ne bloque donc aucun look sur son premier pas.
- **Tempo au micro** (v1, 🎤 du widget Tap) : le micro de l'appareil écoute la salle (sans annulation d'écho, réduction de bruit ni gain automatique, qui écraseraient les attaques) ; toutes les 2 s, les 12 dernières secondes sont analysées dans le navigateur (même analyse que le tempo depuis un fichier, `web/src/audio/listen.ts`). Une lecture n'est suivie que si la précédente est d'accord (à 1 BPM près, nettes toutes les deux) : un changement de chant met donc environ 8 s à être suivi, et un passage sans temps net ne fait rien bouger. Le navigateur envoie le BPM et **depuis combien de temps son dernier temps est tombé** (`tempo.set` avec `source: "audio"` et `beatAgoMs`) ; le serveur suit ce tempo et **rattrape la phase en deux temps**, un peu plus vite ou plus lentement, jamais par un saut ni en arrière (un pas ne flashe pas deux fois, n'est pas sauté). Couper le micro rend un tempo manuel, au dernier tempo entendu ; une page fermée laisse le tempo continuer seul, comme une horloge MIDI absente. Rien n'est enregistré ; seul le tempo part au serveur. Le navigateur n'ouvre le micro qu'en **https ou localhost** (sinon le bouton le dit).
- **Auto-test de cadence** (`selftest.run` avec `cadence`) : chaque look joue seul, la sortie DMX réelle est échantillonnée et les changements de pas sont chronométrés (premier changement de chaque pas, fondus jusqu'à un demi-pas) ; tolérance 25 ms ou 5 % sur la **cadence médiane** ; un **à-coup isolé** (une trame retardée par une machine chargée) est signalé mais toléré, deux ou plus échouent.

## Tests
- Fusion HTP/LTP et priorités, cascade des groupes, flash qui ignore les masters, masque de règles en dernier.
- Attaque, cadence et ordres (aléatoire pondéré avec graine fixe), pas 0.
- Recalcul au changement de BPM sans saut de phase, PLL de la clock, tempo jamais persisté.
- Détection de conflits.
- Performance : 16 univers à 44 Hz, avec la gigue mesurée.
