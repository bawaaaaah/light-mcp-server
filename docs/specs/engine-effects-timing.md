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
   - **Entre les boutons** (v1, réglage du show `looksMerge`, page Show, 2026-10-22, demandé par l'utilisateur) : plusieurs looks allumés sur les mêmes projecteurs. **« Le dernier lancé recouvre »** (`last`, par défaut, le comportement d'avant) : le look lancé en dernier peint par-dessus les autres là où il peint. **« Valeur haute »** (`highest`) : chaque composante de couleur garde sa valeur la plus haute ; deux looks s'additionnent (rouge + bleu = magenta), un noir n'éteint rien. Chaque look peint d'abord sur sa propre feuille (ses exclusions de groupe ne retirent que ce qu'il peint), puis les feuilles se combinent ; un appareil peint en entier et ses têtes s'additionnent comme la sortie les lit (`venue.ts`, `mergeColors`). Les canaux bruts des looks prenaient déjà la valeur haute ; les positions des lyres restent au dernier lancé.
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
- `timing.entryFade` (secondes) : au lancement, le look part du **noir** sur les cellules qu'il peint et y arrive en fondu ; c'est le « pas 0 d'entrée » et le fondu d'entrée d'une Scene QLC+. L'auto-test de cadence attend la fin du fondu avant de mesurer. Quand le look **remplace un autre look de son groupe exclusif**, il ne part pas du noir : c'est un **fondu enchaîné** (section suivante).

### Fondu de sortie
- `timing.exitFade` (secondes) : à l'arrêt, le look continue de jouer pendant `exitFade` secondes pendant que ses couleurs passent progressivement du plein au noir (même lissage smoothstep que le fondu d'entrée), puis disparaît. Le look n'est plus actif dès l'appel à `stop` (`isActive`/`activeLooks` le signalent tout de suite) : le fondu est un résidu visuel. Les canaux bruts (`look.channels`) sortent avec le même poids que les couleurs (section « Fondu des canaux bruts d'un look ») : les canaux de machine tiennent leur valeur pendant la descente, l'octet de gradateur et les canaux de couleur descendent avec le look, et à l'expiration tout retombe. `stopAll`, `resetLive` (et donc le Panic et l'application d'un instantané) restent immédiats, sans fondu. Relancer le même look pendant son fondu de sortie reprend la copie qui fond à son niveau courant et poursuit son animation ; un look modifié entre-temps, ou dont la palette a changé pendant le fondu, repart à neuf. Les moves s'arrêtent avec la fin des couleurs. Le look qui fond est peint avant les looks actifs : en fusion « dernier » (par défaut) celui qui arrive ou reste en jeu l'emporte sur les couleurs, et son mouvement l'emporte toujours ; en fusion « plus fort », le plus fort des deux gagne canal par canal, donc le look qui fond se voit encore tant qu'il est plus clair. Supprimer un look coupe aussi son fondu ; le contrôle des règles qui refusent ou demandent (`strictBounds`) ne touche pas aux fondus en cours.

### Fondu enchaîné entre looks
- Quand un look B en remplace un autre A par un groupe exclusif **et que B a un `entryFade` > 0**, A ne disparaît pas et B ne recouvre pas A : B monte avec le poids `wB = lissage(t / entryFade)` pendant que A descend avec `wA = 1 − lissage(t / durée de A)` (même lissage smoothstep que les autres fondus). La durée de A est son `exitFade` ; **à 0, c'est l'`entryFade` de B** (les presets, `entryFade` 1 et `exitFade` 0, enchaînent donc en 1 s). Aucun nouveau champ : « fondu de sortie » vaut pour l'ancien look, « fondu d'entrée » pour le nouveau.
- **Par cellule** : les poids de ce qui est sur la cellule s'additionnent, et les couleurs, déjà mises à l'échelle de leur poids, aussi ; au-delà de 1 la cellule est partagée (couleur ÷ somme des poids), jamais plus claire que la plus claire des deux ; en dessous de 1 elle garde son poids (un creux, ou la queue d'un look qui part). Durées égales : somme = 1, enchaîné pur. Sortie plus courte que l'entrée : un creux sombre entre les deux (le réglage de l'utilisateur). Sortie plus longue : la queue de A se voit là où B ne peint pas, et chaque poids reste monotone : **aucun rebond** à la fin de l'entrée de B. Plusieurs anciens (plusieurs groupes exclusifs) : chacun a son poids, additionnés sur la cellule. C'est le **poids** qui compte, pas la luminosité : un ancien look noir, ou dosé à 0, garde son poids et retient B tant qu'il part (B finit son entrée à 1/(1 + poids de A) puis remonte).
- **Où ça se pose** : ce qui part sur les **têtes** que B ne montre pas (une tête qu'il peint, ou tout un projecteur qu'il peint entier ; une tête montre sa couleur, sinon celle du projecteur) passe **sous** les looks actifs, comme un look qui fond, donc un look sans rapport lancé avant B reste visible ; sur les têtes que B montre, ils se partagent la cellule et la feuille est posée **une seule fois**, à la place de B, avec la fusion du show : les autres looks gardent leur fusion habituelle. B est construit sans son entrée depuis le noir (la feuille le met à l'échelle) : pas de double fondu.
- **`entryFade` = 0 : comportement inchangé** (A fond dessous, invisible en fusion « dernier », visible en « plus fort »). Les deux à 0 : coupure nette, et rien ne reste à reprendre : un look relancé repart à neuf, animation comprise.
- Un seul chemin pour qu'un look actif parte (arrêt, relâché par un autre look, échec de reconstruction, suppression) : il part avec le poids qu'il avait, et ce qui partait sous lui continue de partir sur la même feuille, **sans saut**, même si le look suivant n'a pas de fondu. Un look relancé alors qu'il part encore (fondu de sortie ou queue d'un croisement) repart de son niveau courant (le poids de sa queue, sommé et borné) et reprend sa position dans l'animation (son `LookPlayer` est réutilisé, sans redémarrer), sauf si le look a été modifié entre-temps ou si sa palette a changé pendant qu'il était en queue (il repart alors à neuf, avec la définition ou la palette courante). Un enregistrement à l'identique n'est pas une modification : la reprise reste continue. **Renommer, ranger dans un dossier ou annoter** un look (`name`, `tags`, `notes`) ne touche pas à ce qu'il joue : un look actif continue sans redémarrer (ni noir, ni fondu d'entrée rejoué) et une copie en queue reste reprenable ; tout autre changement le relance avec sa nouvelle définition. Son poids de queue ne tombe plus d'un coup. Le look qui part n'est plus actif (`isActive` / `activeLooks`). Ses moves continuent tant que son poids n'est pas nul. `stopAll` et `resetLive` (donc Panic et instantané) coupent tout ; les canaux bruts de A sortent avec son poids (section « Fondu des canaux bruts d'un look ») ; le contrôle `strictBounds` met de côté les transitions du look testé et ne change rien.

### Canaux bruts (machines, lampes, v1)
- Un look peut porter des **canaux bruts** (`channels`) : des canaux hors canevas (fumée, hazer, ventilateur, lampe sans couleur), donnés par projecteur + décalage depuis son adresse, donc **même sans définition**, avec une valeur DMX (0-255) par pas.
- Ils avancent avec l'horloge du look (`every`) : dans l'ordre des couleurs quand le nombre de pas est le même, sinon en boucle. **Un canal de machine ne se fond jamais** : il tient sa valeur pendant les fondus du look, tandis que les décalages de gradateur et de couleur que le look écrit suivent son poids (section suivante).
- **Fonctions par leur nom** (v1) : un canal découpé en fonctions (le mode d'une barre LED, ses scènes de couleur, ses macros) les propose dans chaque case, avec leur plage (`venue.fixture.channels` les donne, `ranges`) ; en choisir une met la valeur au début de sa plage, et le nombre reste modifiable. Cas réel : une scène de couleur d'une barre demande son « Mode Selection » sur « Color Presets » et le canal « Color Presets » sur la couleur voulue, deux choix par leur nom.
- Ils fixent leurs canaux après la conversion du canevas, une fois tous les projecteurs peints (un décalage qui déborde sur les adresses du voisin n'est pas recouvert par lui) ; deux looks sur le même canal : le plus haut l'emporte à plein poids, et en fondu ils se partagent le canal (section « Fondu des canaux bruts d'un look ») ; les faders de canaux (HTP) puis le **masque de règles** passent après. Ils ne sont pas dosés par les DCA (une vitesse de ventilateur ne se dose pas).
- Avec la technique `aucune`, c'est un **bouton machine** : « Fumée 50 % », « bouffées de hazer toutes les 2 s ».
- **Éditeur** : rubrique « Canaux bruts » de l'éditeur de looks ; un canal se choisit par projecteur puis par nom (ou par numéro sans définition) ; une grille donne la valeur de chaque canal à chaque pas.

### Fondu des canaux bruts d'un look (T3, 2026-11-08)
- Le poids de fondu du look — son `entryFade` à la montée, `1 − lissage(t)` à la sortie avec fondu, le poids du croisement en enchaîné — accompagne **toutes ses écritures brutes**, à la montée comme à la descente (symétrie), avec le même lissage smoothstep que les couleurs. Un look arrêté **en cours de montée** garde son entrée qui court sous le fondu de sortie (les deux se composent, comme les couleurs les composent déjà), et un look **relancé en cours de montée** (repris de sa queue) la garde aussi : son poids est celui du croisement × son entrée, sans saut. Les couleurs qu'un look peint gardent leur mécanique propre (montée de l'entrée dans les pas du joueur, croisement partagé par cellule) : le poids des feuilles de couleurs n'est pas repris ailleurs, il est déjà dosé dans ces feuilles.
- **Par canal, un seul dosage**, dans la conversion en DMX (`venue.toDmx`) : le moteur collecte, par (projecteur, décalage), **chaque écriture avec le poids de son look, le look et sa feuille** (`RawWrite`) — un fondu enchaîné et les looks qu'il remplace partagent une feuille, tout autre look a la sienne —, et la conversion pose les octets en une seule passe, après les couleurs peintes de tous les projecteurs :
  - **Trois classes de looks, par projecteur** : un look qui **peint** le projecteur ou écrit l'un de ses **décalages de couleur** dose sa lumière **par ses couleurs** ; un look qui écrit son **gradateur sans couleur** (une scène passée par un canal de mode : gradateur + « Program ») la dose **par ce gradateur** ; un look qui n'écrit que des **canaux de machine** ne la dose pas (voir « Le poids machine »).
  - un décalage du **gradateur** (`intensity` dans la définition) : les looks **possèdent l'octet**, dosé **une seule fois**, **à partir de ce que le show y tient** (`rawOver`), lu **avant** que le moindre canal brut ne soit posé (deux projecteurs patchés sur les mêmes adresses ne se passent pas leur dose). L'octet tenu dépend de la classe du look qui écrit : sous un look qui dose par ses couleurs, c'est le gradateur que le show tient (ou le niveau peint d'une lampe) — son gradateur va de cet octet au sien et c'est sa couleur qui porte le fondu, **une seule fois** (un look « scène » gradateur 255 + couleurs brutes n'est plus dosé gradateur × couleur, poids²) ; sous un look qui dose par son gradateur, c'est seulement ce qui éclaire **d'autre** le projecteur (gradateur tenu × min(1, poids machine + poids des looks qui dosent par leurs couleurs)) : **seul, il monte du noir** et y redescend. Un look à gradateur brut qui entre sur un projecteur éclairé va donc de l'octet tenu à son niveau **sans passer par le noir**, et revient à l'octet tenu en sortant.
  - **Composition** : chaque **feuille** est un calque, d'opacité son poids (au plus 1) et de valeur la moyenne pondérée de ses écritures — un croisement dans une feuille va d'une valeur à l'autre sans creux ni saut (255 → 200 en fondus égaux reste entre 200 et 255) ; au-delà de 1 la feuille partage le canal (÷ ses poids). Le résultat est `tenu × (1 − opacité combinée) + opacité combinée × la plus haute valeur de calque`, chaque valeur pesée par son opacité rapportée au calque le plus opaque. Entre feuilles — des looks qui ne se croisent pas — **le plus haut l'emporte à plein** (HTP), un look qui vient d'arriver ne saute pas par-dessus celui qui est déjà là (deux looks à 200 et 100 lancés à 500 ms d'écart : 255 → 200, monotone), deux looks à 255 lancés ensemble restent à 255, et un look sans rapport qui écrit 0 ne creuse pas un croisement. Le fondu du show et autres doses ne le multiplient plus, les faders de canaux et le masque de règles s'appliquent derrière comme sur les autres octets ; ni le grand master ni les DCA ne dosent un canal brut (une vitesse de ventilateur ne se dose pas), un gradateur brut compris.
  - un décalage de **couleur** (une composante de tête) : même composition, à partir de la couleur peinte là (la couleur suit les looks). Limite connue : un look qui peint une composante **et** l'écrit en brut part de sa propre peinture (un brut à 50 sous un blanc peint fait une bosse vers 91 avant de redescendre à 50).
  - tout autre canal (roue, macro, effet, strobe, attribut inconnu) : **verbatim** à la valeur la plus forte, jamais fondé — « une machine ne se fond pas » (T5) — et le poids de son look dose le gradateur (ci-dessous) ;
  - un décalage **hors définition** (projecteur avec ou sans définition) : **verbatim**, sans fondu.
- **Le poids machine** — reconstruit **à chaque trame** (rien ne traîne), **look par look** : un look qui peint le projecteur (`frame.painted`, par look), écrit l'un de ses décalages de couleur ou son gradateur **se dose lui-même** (classes ci-dessus) ; un look qui n'y écrit que des canaux de machine ne le peut pas, et son poids compte **une fois par look**, quel que soit le nombre de canaux qu'il tient (une lyre dont le look tient pan, tilt, gobo et prisme fond à la vitesse de son look). Un look qui **peint** le projecteur et y tient un canal de mode est donc dosé une seule fois, par ses couleurs. La somme `m` de ces poids machine (bornée à 1 : un croisement de deux machines ne creuse pas le gradateur) agit sur l'**octet de gradateur** que le show tient à fond ([groups-masters](groups-masters.md), « Moteur ») : quand la couleur de ce qui pilote le projecteur ne peut pas se mettre à l'échelle (une machine, une roue par canal de mode), **le fondu agit sur le gradateur**. Avec `p` le poids (borné à 1) de ce qui se dose soi-même, le gradateur suit `machineFade(m, p) = 1 − (1 − m)(1 − p) · m / (m + p)` (0 si les deux sont nuls) : **1 sans look machine**, 1 aussi quand `m` vaut 0 et que quelque chose se dose déjà (un look machine qui commence sur un projecteur éclairé ne lui retire rien), `m` seul quand rien d'autre n'est là, 1 quand ce qui se dose soi-même est à plein, et continu partout **sauf à l'origine** : un look peint qui s'éteint sous un look machine en fondu, ou un look machine qui commence ou finit pendant qu'un look peint est déjà en route, ne fait pas sauter le gradateur ; mais un look machine et un look qui se dose **lancés (ou arrêtés) ensemble** partent tous deux de 0, et aucune formule sans mémoire ne peut valoir 1 en (0, p), m en (m, 0) et rester continue en (0, 0) : le gradateur y saute vers environ la moitié en une trame. Limite connue, en attente d'une décision (mesurer `p` par la lumière réelle, ou lisser le gradateur dans le temps). Un poids machine nul sur un projecteur que rien n'éclaire dose bien à 0 (le tout début d'une entrée). Un projecteur à **lampe et roue** (`lampOnly`, la couleur s'exprime par case) fonde par son gradateur, dont le niveau est **le niveau peint, déjà dosé par le poids des looks qui le peignent** : le poids machine ne l'atteint **jamais** (le doser encore le fondrait deux fois quand le même look peint la lampe et tient sa roue, et un look de roue en fondu creusait la lampe qu'un autre look éclaire ; non peinte, la lampe reste éteinte de toute façon) — la roue tient sa case dans tous les cas, jamais interpolée.
- **À l'arrêt** : `stop` avec `exitFade` fait tout descendre avec le poids (les canaux de machine tiennent leur valeur pendant la descente), puis à l'expiration tout retombe ; `stopAll`, `resetLive` (donc Panic, instantané) coupent **tout de suite**, sans état intermédiaire (les copies qui fondent n'existent que si `exitFade > 0`).
- **Vérification régie (critère de déploiement, faite le 2026-11-11)** : avec l'utilisateur devant le matériel, sur une lyre à lampe et roue (Spot 200, 14 canaux) et une barre LED RGBW (SonicPulse Bar 10, 6 canaux), fondus de 3 s à l'entrée et à la sortie : un look peint (couleur), un look « scène » (gradateur + rouge bruts) et un look lyre (couleur sur la roue + gobo brut). Tout fond en douceur ; sur la lyre **seule la luminosité bouge**, la roue et le gobo tiennent jusqu'à l'expiration ; `dmx.explain` nomme le look qui sort, marqué « en train de sortir ». Reste à voir sur le groupe extérieur d'origine s'il diffère de ces appareils.

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
  - sources : manuel, tap, **MIDI clock** (PLL, lissage, détection d'arrêt, SPP), **micro** (v1, ci-dessous), **DJ** (OS2L, [MIDI](midi.md)) ; la source se choisit dans la page MIDI (« Le tempo suit »), et l'état du tempo dit si une horloge MIDI arrive même quand elle n'est pas suivie (`clock`) : le widget Tap montre alors « ↺ MIDI », qui rend la main à Ableton d'un appui (après un tempo tapé ou un Tap, rien ne permettait de revenir à l'horloge depuis l'interface) ;
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
