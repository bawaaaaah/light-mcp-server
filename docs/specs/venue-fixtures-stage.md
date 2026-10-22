# Lieu : fixtures, patch, scène et canevas

Le **lieu** est une des trois couches de données (machine / lieu / show, voir [architecture](../architecture.md)). Il contient tout ce qui dépend de la salle et du kit. Plusieurs shows partagent un même lieu, ce qui évite tout repatch.

## Périmètre
| v1 | Plus tard |
|---|---|
| Fixtures (OFL, `.qxf`), patch, scène 2D, rôles, **canevas et rendu**, zones protégées, live preview 2D | Vue 3D (three.js, faisceaux), RDM |

## Fixtures
- **Format interne** (zod) aligné sur l'[Open Fixture Library](https://open-fixture-library.org) : fabricant, modèle, modes, canaux.
  - **Capabilities** typées : Intensity, ColorIntensity (R/G/B/W/A/UV/C/M/Y), ColorWheel, Pan, Tilt (avec plage en degrés), Strobe/Shutter, Gobo, Prism, Focus, Zoom, Iris, Effect, Maintenance…
  - Fine 16 bits, valeur par défaut.
- **Tags de capabilities** : `soundActive`, `autoProgram`, `builtinMacro`, `uv`, `strobe`, `reset`, `fan`, `lamp`… Ils sont déduits à l'import et corrigeables. Ce sont eux qui permettent les règles globales du type « interdire tous les modes son-actif ».
- **Import** : OFL (JSON) et QLC+ `.qxf` (XML). L'UI contient un éditeur de fixtures.
- **Sorties de machine** (v1) : un canal d'intensité dont le nom désigne une machine (fumée, brume, bulles, ventilateur, fluide, pompe, neige, mousse, confettis, flammes, étincelles, CO2…) est lu comme un **effet**, pas comme un gradateur, même si la définition QLC+ lui donne le preset `IntensityDimmer` (cas réel : une machine à bulles et brume avec LED RGB). Sinon chaque couleur peinte sur ses LED mettait sa fumée, ses bulles et son ventilateur **à fond**. Ces sorties ne bougent que par les canaux bruts d'un look ; le gradateur des LED reste un gradateur.
- **Sélecteurs rangés en intensité** (v1) : un canal du groupe *Intensity* découpé en fonctions distinctes (« 0-63 chenillard RGBW, 64-127 Color Presets, 128-191 macros, 192-255 musique », « stop / trigger / loop », « off / on », une vanne) est un **sélecteur**, pas un gradateur : il n'est jamais poussé à fond avec la couleur. Un niveau reste un niveau : une seule plage, ou des plages toutes d'intensité (« dimmer 0-100 % », « off », « transparent »). Cas réel : le canal « Mode Selection » d'une barre LED mis à 255 la passait en mode musique, et ses scènes de couleur ne répondaient plus ; sur une bibliothèque de 14 000 canaux, 128 changent ainsi de classe, dont la vanne d'un jet de CO2 et des relais.
- **Gradateur générique de QLC+** (fabricant et modèle « Generic », mode « N Channel ») : QLC+ le crée dans son code, sans `.qxf`. Le serveur le connaît d'office (jusqu'à 64 canaux, tous en intensité) et la bibliothèque le propose.
- **Validation de la bibliothèque** : on signale une définition dont le nom de fichier ne correspond pas au contenu (cas réel : deux définitions inversées).
- **Attributs normalisés** de 0 à 1. Le moteur ne voit jamais de canaux, d'où le **copier-coller d'attributs entre types différents** (Lightkey).
- **Cellules** : les fixtures multi-cellules sont adressables cellule par cellule, partout.

## Patch
- Une instance porte : id, nom, type et mode, univers et adresse, tags, position sur la scène, montage, rôle, notes, et pour une lyre `orientation` (`yaw`, inversion pan/tilt, swap pan/tilt, décalages de calibration en degrés).
- Le patch détecte les **conflits d'adresse** (`venue/patch-check.ts`) : deux projecteurs dont les canaux se chevauchent sont signalés au moment de patcher (le patch se fait quand même : avertissement), par `venue.patch.check`, par « Vérifier le show » et dans la page Lieu (⚠ « chevauche », détail au survol) ; deux projecteurs du même modèle et mode à la même adresse (jumelés exprès) ne le sont pas. Les projecteurs **sans définition** (`.qxf` absent de la bibliothèque : canaux non décodés) sont signalés de même (badge « sans définition », une alerte par modèle dans la vérification). La page Lieu liste le patch **par univers et adresse**, comme une console. Il propose un patch automatique (« auto » : première adresse libre).
- Le patch peut être importé depuis un `.qxw`.
- **Nom et couleur de repère** (2026-10-22, demandé par l'utilisateur) : un clic droit sur une ligne du patch (appui long sur tablette) ouvre un menu pour **renommer** l'appareil et lui donner une **couleur de repère** (les teintes des widgets, ou une autre ; « sans couleur » l'enlève) ; `venue.fixture.mark`. La couleur sert à reconnaître l'appareil d'un coup d'œil : pastille dans le patch et dans l'arbre des canaux (faders, groupes), nom écrit de sa couleur sur la scène en direct. Elle n'est **jamais envoyée** à l'appareil (rien à voir avec ce qu'il éclaire). L'id, l'adresse et le reste ne bougent pas.

## Scène virtuelle
But : générer des **effets spatiaux** et permettre à **l'IA de comprendre la scène**.

- **Repère** : en mètres. X va de jardin (−) à cour (+), Y de l'avant-scène (0) vers le lointain, Z est la hauteur depuis le sol de la salle.
- **Zones** : polygones nommés, chacun avec une hauteur de plancher.
  - Types : `stage`, `riser` (praticable), `floor` (pied de scène), `audience`, `wall`, `pillar`, `truss`, `ceiling`, `backdrop`.
  - Tags libres et notes.
  - Drapeau **`protected`** (pupitre, public), appliqué par le moteur ([rules-limits](rules-limits.md)).
- **Fixture sur scène** :
  - `position {x,y,z}`, zone d'accroche ;
  - `mount` : `floor | stand | truss | hung | wall | pillar | ceiling` ;
  - **Orientation** (v1, demandée le 2026-10-17) : où pointe le projecteur au repos. `yaw` = cap de sa face avant, en degrés : 0 vers le public, 90 vers le mur **cour** (à droite vu du public, +X), 180 vers le **mur de scène** (fond), −90 vers le mur **jardin** (à gauche vu du public, −X) ; `pitch` = inclinaison, de −90 (vers le **sol**) à 90 (vers le **plafond**), 0 = à l'horizontale (`venue/orientation.ts`).
    - `venue.fixture.orient {id, facing | yaw | pitch | turn}` : six directions nommées (`audience`, `upstage`, `houseLeft` = jardin, `houseRight` = cour, `ceiling`, `floor` ; plafond et sol gardent le cap, une barre garde sa ligne), un angle, ou une rotation relative. `venue.fixture.list` nomme la direction (`facing`) quand l'orientation en est une.
    - Une **lyre** tournée vers le sol est accrochée (tête en bas), vers le plafond posée, quel que soit son montage ; à moins de 45° de l'horizontale, le montage décide. La visée et la calibration en tiennent compte.
    - Plus tard : `roll`, et des raccourcis « douche », « contre-jour », « rasant mur », « vise la zone X ou le point P ».
  - `target` calculé dans les deux sens.
  - **Lyres** (v1) :
    - la définition donne les canaux pan/tilt (8 ou 16 bits, avec `fine`) et la course en degrés (`<Physical><Focus PanMax TiltMax>` du mode, sinon de la fixture, sinon 540°/270°) ;
    - le moteur manipule une **position logique normalisée** (0..1 de la course, 0,5 = centre) ; le lieu applique inversion, swap et encodage 16 bits ; une lyre que rien ne pilote reste **au centre** ;
    - **viser** une zone (son centre, à 1,5 m au-dessus de son plancher par défaut) ou un point : calcul depuis la position, le montage (accrochée = retournée) et le `yaw`, en gardant la solution la plus proche du centre ; hors de portée = signalé ;
    - lyre sans mélange de couleurs : la couleur peinte par le look choisit le **créneau de roue** le plus proche et son niveau pilote le gradateur ; le shutter est mis sur sa valeur « ouvert » ;
    - **Blackout** éteint la lumière mais **garde pan/tilt** (les lyres ne partent pas en butée) ;
    - **calibration guidée** (v1, comme dans Lightkey ; page Lieu, « Calibrer les lyres ») : on vise à la main (pad XY) deux ou trois repères au sol connus (centre d'une zone ou point), on les enregistre (`calibration.record`, valeurs réellement envoyées, inversions comprises), puis `calibration.solve` trouve le **yaw**, le **décalage de tilt** et les **inversions pan/tilt** (recherche exhaustive, écart angulaire par repère). Le décalage de pan est confondu avec le yaw pour une lyre de niveau. Un écart moyen au-delà de 3° est signalé, et l'application demande confirmation ;
    - pan/tilt → direction (sens inverse de la visée, v1) : ce que montre la scène en direct ;
    - plus tard : lyre non horizontale.
  - **Rôle** : `face | contre | douche | latéral | wash-public | blinder | effet | découpe | wall-wash | décor | machine`.
- **Usages** :
  - effets spatiaux (balayage par X, vague par Y, montée par Z, radial) ;
  - pad XY de scène ;
  - requêtes de l'IA (`light_stage_query`) ;
  - exclusion d'un rôle ou d'une zone dans un effet (Onyx).

## Canevas et rendu (concept central, v1)
- Un **canevas** est la surface abstraite sur laquelle on écrit les techniques et les effets. Il a N cellules et une topologie (voisinage, symétrie). Types :
  - `line` ;
  - `line-mirror` (composition depuis le centre) ;
  - `ring` (barres en carré, public au centre) ;
  - `grid` ;
  - libre (positions 2D).
- Le **rendu** fait correspondre canevas et fixtures, **par lieu**. Par exemple, un mur de 32 cellules en blocs de 4, chaque bloc attribué à un appareil de la salle. Le même show se **rejoue sur un autre kit** sans réécriture, avec la symétrie préservée.
- Un lieu peut définir plusieurs canevas (fond de scène, parvis…). Un look ou une technique cible un canevas, ou un groupe ou rôle.

## UI
- **Page Lieu** : fixtures, patch, nodes.
  - **Zones** (v1) : liste avec leur taille et suppression ; création d'une zone **rectangulaire** par sa largeur (de jardin à cour) et sa profondeur, centrée sur X (0 au milieu, cour en positif), son bord avant à Y (0 au nez de scène, le public en négatif), hauteur de plancher, protégée ou non, **interdite aux lyres** ou non (case aussi sur chaque zone de la liste ; hachurée sur le plan, voir [rules-limits](rules-limits.md)). Les formes plus complexes passent par l'IA (`light_stage_zone_put`, polygone).
- **Page Scène** : vue de dessus éditable (formes, truss, image de fond à l'échelle) et vue de face, post-it d'annotation.
- **Page Canevas** : définition, rendu par glisser-déposer des blocs sur les fixtures, aperçu.
- **Live preview 2D** : faisceaux qui reflètent intensité, couleur, zoom et strobe, à partir des valeurs du moteur.
  - v1 (page Lieu, « Scène en direct ») : vue de dessus, public en bas ; zones d'après leurs polygones (zones protégées en pointillé rouge) ; chaque tête colorée **d'après la sortie DMX réelle** (après règles, forçages et Blackout ; sujet `light:preview`, à chaque changement et au moins une fois par seconde) ; les projecteurs sans position sont alignés devant la scène. Avec des lyres, un mode « Viser » les pointe sur l'endroit cliqué (`position.aim`, à 1,5 m au-dessus du plancher de la zone). Un mode « Placer » permet de **glisser les projecteurs** à leur place (pas de 10 cm ; hauteur par défaut selon le montage : 5 m accroché, 1,8 m sur pied, 3 m au mur, 0,3 m au sol).
  - **Vue de face** (v1, bouton « Face ») : hauteurs vues depuis le public (X, Z), praticables à leur hauteur de plancher ; en mode « Placer », glisser un projecteur y règle sa **hauteur** (la profondeur est conservée).
  - **Strobe** (v1) : un projecteur allumé dont un canal est dans une plage strobe porte un cadre pointillé fixe et « ⚡ », avec la fréquence quand sa définition la donne (« ⚡ 12 Hz ») ; l'écran ne clignote jamais, un écran qui clignote étant lui-même un risque photosensible.
  - **Placer la sélection** (v1, sous le patch ; `venue.fixture.arrange`) : les projecteurs cochés, dans l'ordre où ils ont été cochés, régulièrement espacés le long d'un bord d'une zone (nez côté public, fond, côté jardin, côté cour, ou au milieu), de jardin à cour ou de l'avant vers le fond, à 30 cm du bord ; hauteur donnée au-dessus du plancher de la zone, sinon selon le montage (5 m accroché, depuis le sol de la salle ; 1,8 m sur pied, 3 m au mur, 0,3 m au sol, depuis le plancher de la zone) ; orientation commune en option. Pour placer d'un coup une rampe de barres ou une ligne de PAR, puis ajuster à la main.
  - **Orienter** (v1, case de la « Scène en direct ») : un clic sur un projecteur, puis les six directions en boutons (Public, Mur de scène, Mur jardin, Mur cour, Plafond, Sol), ⟲ / ⟳ 15° (ou ← / → au clavier), un cap et une inclinaison en degrés, ou un glisser autour du projecteur pour le tourner (par 15°, librement avec Maj ; en vue de dessus). Vu de dessus, le corps du projecteur tourne avec son cap ; une flèche montre le faisceau, ⊙ quand il pointe vers celui qui regarde (le plafond vu de dessus, le public vu de face), ⊗ à l'opposé.
  - **Faisceaux** (v1) : un projecteur allumé dont on connaît la direction projette un cône de sa couleur jusqu'à l'endroit où la lumière touche le plancher de la zone en dessous (2 m sinon ; point d'impact calculé par le serveur, `landing` dans `stage.ts`) ; vu de dessus, une tache marque l'impact. Pour un projecteur fixe, la direction vient de son orientation ; pour une **lyre**, du pan/tilt **réellement envoyé** (sujet `light:preview`, `beams`), relu en sens inverse de la visée (inversions et swap défaits, `pointing` dans `aim.ts`) : la scène montre où pointent les lyres, à la main, par « Viser » ou par un Move FX. Sans position ni orientation, le halo reste. L'ouverture du cône est celle de l'optique quand la définition la donne (`<Lens DegreesMax>`, le plus large d'un zoom), 24° sinon, dessinée entre 4° et 120°.
  - **Zoom** (v1, boutons − / + de la Scène en direct, ×1 à ×4) : le plan grandit dans son cadre, qui défile, en gardant au centre ce qui y était ; le cadre tient dans 75 % de la hauteur de l'écran.
  - **Zoom en direct** (v1) : pour un projecteur dont la définition a un canal de zoom (`BeamZoomSmallBig` ou `BeamZoomBigSmall`) et une optique à plage (`<Lens DegreesMin DegreesMax>`), l'ouverture du cône suit la valeur envoyée sur ce canal, entre l'angle le plus étroit et le plus large.
  - **Vue 3D** (v1, bouton « 3D » de la Scène en direct, chargée à la demande : three.js reste hors du reste de l'interface) : zones en volume à leur hauteur de plancher (arêtes rouges pour les protégées et celles interdites aux lyres), projecteurs à leur place, tournés selon leur cap et allumés dans leur couleur réelle, faisceaux en cônes lumineux jusqu'à leur point d'impact (calculé par le serveur) ; caméra cadrée sur la scène depuis le public, glisser pour tourner, molette pour zoomer, clic droit pour déplacer. Le placement et l'orientation restent sur le plan 2D.

## MCP
`light_venue_*`, `light_fixture_search` et `light_fixture_import`, `light_patch_plan` puis `light_apply`, `light_stage_zone` et `light_stage_place`, `light_stage_query`, `light_protect_zone`, `light_canvas_*`, `light_venue_map_canvas`, `light_identify`, `light_calibrate_pantilt`, `light_position_aim` (et `light_position_set`, `light_position_release`). Ressource `light://stage`.

## Tests
- Imports OFL et `.qxf`, déduction des tags.
- Conflits de patch.
- Calculs d'orientation et de pan/tilt (lyre suspendue ou au sol).
- Rendu d'un canevas sur deux kits différents, avec la symétrie conservée.
