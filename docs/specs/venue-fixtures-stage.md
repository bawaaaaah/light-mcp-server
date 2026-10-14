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
- **Validation de la bibliothèque** : on signale une définition dont le nom de fichier ne correspond pas au contenu (cas réel : deux définitions inversées).
- **Attributs normalisés** de 0 à 1. Le moteur ne voit jamais de canaux, d'où le **copier-coller d'attributs entre types différents** (Lightkey).
- **Cellules** : les fixtures multi-cellules sont adressables cellule par cellule, partout.

## Patch
- Une instance porte : id, nom, type et mode, univers et adresse, tags, position sur la scène, montage, rôle, notes, et pour une lyre `orientation` (`yaw`, inversion pan/tilt, swap pan/tilt, décalages de calibration en degrés).
- Le patch détecte les conflits d'adresse et propose un patch automatique.
- Le patch peut être importé depuis un `.qxw`.

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
  - `orientation {yaw,pitch,roll}`, avec des raccourcis : « vers le public », « vers le mur du fond », « douche », « contre-jour », « rasant mur », « vise la zone X ou le point P ».
  - `target` calculé dans les deux sens.
  - **Lyres** (v1) :
    - la définition donne les canaux pan/tilt (8 ou 16 bits, avec `fine`) et la course en degrés (`<Physical><Focus PanMax TiltMax>` du mode, sinon de la fixture, sinon 540°/270°) ;
    - le moteur manipule une **position logique normalisée** (0..1 de la course, 0,5 = centre) ; le lieu applique inversion, swap et encodage 16 bits ; une lyre que rien ne pilote reste **au centre** ;
    - **viser** une zone (son centre, à 1,5 m au-dessus de son plancher par défaut) ou un point : calcul depuis la position, le montage (accrochée = retournée) et le `yaw`, en gardant la solution la plus proche du centre ; hors de portée = signalé ;
    - lyre sans mélange de couleurs : la couleur peinte par le look choisit le **créneau de roue** le plus proche et son niveau pilote le gradateur ; le shutter est mis sur sa valeur « ouvert » ;
    - **Blackout** éteint la lumière mais **garde pan/tilt** (les lyres ne partent pas en butée) ;
    - plus tard : **calibration guidée** (viser deux ou trois repères au sol, comme dans Lightkey) et pan/tilt → point (sens inverse).
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
- **Page Scène** : vue de dessus éditable (formes, truss, image de fond à l'échelle) et vue de face, post-it d'annotation.
- **Page Canevas** : définition, rendu par glisser-déposer des blocs sur les fixtures, aperçu.
- **Live preview 2D** : faisceaux qui reflètent intensité, couleur, zoom et strobe, à partir des valeurs du moteur.
  - v1 (page Lieu, « Scène en direct ») : vue de dessus, public en bas ; zones d'après leurs polygones (zones protégées en pointillé rouge) ; chaque tête colorée **d'après la sortie DMX réelle** (après règles, forçages et Blackout ; sujet `light:preview`, à chaque changement et au moins une fois par seconde) ; les projecteurs sans position sont alignés devant la scène. Avec des lyres, un mode « Viser » les pointe sur l'endroit cliqué (`position.aim`, à 1,5 m au-dessus du plancher de la zone).
  - Plus tard : zoom, strobe, faisceaux des lyres, vue de face, glisser-déposer des positions.

## MCP
`light_venue_*`, `light_fixture_search` et `light_fixture_import`, `light_patch_plan` puis `light_apply`, `light_stage_zone` et `light_stage_place`, `light_stage_query`, `light_protect_zone`, `light_canvas_*`, `light_venue_map_canvas`, `light_identify`, `light_calibrate_pantilt`, `light_position_aim` (et `light_position_set`, `light_position_release`). Ressource `light://stage`.

## Tests
- Imports OFL et `.qxf`, déduction des tags.
- Conflits de patch.
- Calculs d'orientation et de pan/tilt (lyre suspendue ou au sol).
- Rendu d'un canevas sur deux kits différents, avec la symétrie conservée.
