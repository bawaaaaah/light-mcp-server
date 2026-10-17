# Règles et limites (garde-fous)

Une seule mécanique gère toutes les limites : max par attribut, modes interdits, zones protégées, marqueurs de widgets, sécurité des sections. Le **masque de règles** est la **dernière étape du moteur** avant la conversion DMX : aucune source ne le contourne, ni un effet, ni la timeline, ni l'IA.

## Principes
- **Pas de règle = liberté totale.** Aucune limite sur le choix des couleurs par défaut.
- Une règle porte sur un **attribut** ou une **capability** (plage de valeurs d'un canal).
- L'UI affiche toujours la **règle effective et sa provenance**, par exemple : « UV max 40 %, défini sur le type *Barre LED X*, surchargé par le groupe *Parvis* ».

## Périmètre
| v1 | Plus tard |
|---|---|
| Cascade à **3 niveaux** ; **programmes de règles** (par section, par Program Change) ; zones protégées ; drapeaux de section ; scènes sans intensité par défaut ; politique strobe ; marqueurs | Niveau rôle ; `appliesTo` différencié pour l'IA en live |

## Cascade v1 (du plus général au plus précis)
1. **Type de fixture** (bibliothèque) : règles de base de la fixture. Exemples :
   - « canal 7, plage 200‑255 = son-actif → interdit » ;
   - « UV max 50 % » ;
   - **valeur minimale imposée** : cas réel d'une barre noire tant que son canal « strobing » est sous 32, d'où `min = 32` sur ce canal, posé une fois pour toutes.
2. **Lieu et show** : règles globales par catégorie de capability (« interdire tous les modes son-actif et programmes internes », « strobe ≤ 10 Hz ») et contraintes du lieu.
3. **Groupe ou widget** : limites d'un groupe ([groups-masters](groups-masters.md)) et **marqueurs** posés sur un fader ou un bouton.

Le niveau le plus précis gagne, sauf si un niveau supérieur a posé **`locked`** (sécurité matérielle, contrainte du lieu), qu'aucun niveau inférieur ne peut relâcher.
- Concrètement (v1) : **chaque borne** (min, max, valeurs permises, modes interdits) vient de la règle la plus précise qui la définit — niveau (type < lieu < show), puis portée (tout < modèle < zone < projecteur). Un show peut donc **assouplir** la limite d'un type ; deux bornes contradictoires (min au-dessus du max) : celle de la règle la plus précise l'emporte. Les règles `locked` sont réappliquées par-dessus.
- `rule.effective {fixture}` donne, canal par canal, la règle en vigueur et la provenance de chaque borne.
- **Interface** (v1, page Lieu, « Règles et limites ») : liste et suppression ; création (niveau, portée tout/modèle/projecteur/zone, canal gradateur/UV/blanc/strobe/pan/tilt/effets ou canal nommé, min/max en %, modes interdits, verrouillée) ; règles en vigueur d'un projecteur avec leur provenance ; valeurs bornées sur la dernière trame.

## Programmes de règles (v1, demandé le 2026-10-15)
- Un **programme** regroupe des règles pour un moment du culte : « prière : rien au-dessus de 40 %, pas de strobe », « annonces »… **Un seul est actif à la fois** (ou aucun). Une règle peut porter un `program` : elle ne s'applique que pendant ce programme ; les règles sans programme s'appliquent toujours.
- **Activation** :
  - **Program Change MIDI** reçu sur le canal du programme, sans mapping à créer (numéro 0-127 comme l'octet MIDI ; Live l'affiche +1 : un clip « Prière #100 » envoie 99) ;
  - **section de chant** portant un programme ; une section sans programme **garde** le programme actif (décidé le 2026-10-15) : seul un autre programme, un Program Change ou la main le remplace ;
  - interface (page Lieu, « Règles et limites ») et commande `program.select` ;
  - repris après un redémarrage (état en direct).
- Le programme actif s'affiche dans l'en-tête ; `rule.effective` tient compte du programme actif (ou de celui demandé).
- Exports : clip `.alc` par programme (Program Change au lancement) et `.mid` par chant ([midi](midi.md), Ableton).

## Toujours actifs en v1 (hors cascade)
- **Zones protégées** : une zone marquée `protected` (pupitre, public) a ses propres limites. Par exemple « intensité ≤ 60 % vers *audience* », « aucune lyre ne vise *pupitre* sauf look autorisé ».
  - **Interdite aux lyres** (v1, `noAim` de la zone, case dans la page Lieu) : une lyre dont le faisceau **traverse** la zone, jusqu'à 2,5 m au-dessus de son plancher, est éteinte (gradateur, ou couleurs sans gradateur) tant qu'elle y pointe. La direction vient du pan/tilt **réellement envoyé** (visée inversée), donc quel que soit celui qui l'a visée : look, Move FX, pad XY, « Viser », console DMX. Appliqué après les forçages ; le bornage figure dans « pourquoi ce canal » (`zone:<id>`). **Looks autorisés** (`allowLooks` de la zone, « sauf : » dans la page Lieu) : tant que l'un d'eux joue, la zone est ouverte aux lyres (une découpe voulue sur le pupitre).
- **Drapeaux de section** (posés sur une section de chant, actifs pendant cette section) :
  - `manualOnly` : jamais déclenchée par la timeline ni par l'IA, au doigt seulement (v1 : vérifié dans le moteur lui-même, donc aussi pour les sections lancées par l'IA, par une action de timeline ou par le suivi de position ; le suivi passe la section sans lancer le look. Le MIDI reste autorisé : un pad est un doigt — une note envoyée par un clip d'Ableton aussi, à éviter sur ces looks) ;
  - `noCut` : seules les techniques qui n'éteignent rien sont admises (v1 : vérifié à l'enregistrement du look) ;
  - **plancher d'intensité** : « le sol n'est jamais noir » (v1 : une règle `min` dans un programme posé sur la section) ;
  - **règles machines** : « pas de bulles pendant une prise de parole », « brume jamais au tempo » (v1 : une règle `max` 0 sur le canal de la machine, dans un programme ; le tempo d'une machine reste à faire).

## Options de show (activées par défaut à la création)
- **Scènes sans intensité** : les looks portent couleur et effets, et le **niveau** vient exclusivement des groupes et masters, parce qu'il dépend de la salle du soir. Le moteur refuse d'enregistrer de l'intensité dans un look. L'UI rappelle « master en bas = rien ne s'allume ».
- **Politique strobe** : le canal strobe n'est écrit que par un **fader désigné**, sauf par le **Blackout**, qui le remet à zéro. Les flashs sont des pas de couleur, pas du strobe.

## Types de contraintes
| Type | Exemple | Effet |
|---|---|---|
| `max` / `min` | UV ≤ 40 %, plancher 15 % | borne la valeur |
| `range` | zoom de 20 à 80 % | borne la valeur |
| `values` | 0, 50 ou 100 % seulement | arrondit à la valeur autorisée la plus proche |
| `forbidCapability` | son-actif, programmes auto, macros, reset | remplace par la valeur par défaut ou la plage permise la plus proche |
| `allowCapabilities` | seulement couleur fixe et dimmer | liste blanche |
| `rate` | strobe ≤ 10 Hz (`maxHz`, fait), pan/tilt ≤ X°/s | borne la fréquence ou la vitesse |
| `duration` | blinder ≥ 80 % pendant 3 s au maximum (`hold`, fait) | borne la durée |
| `aim` | ne jamais viser *audience* sous 2 m | interdit un angle ou une cible (via la scène) |

`onViolation` : `clamp` (défaut, on borne et on informe), `confirm` (confirmation dans l'UI) ou `reject`.

- **Durée bornée** (v1, `hold {above, seconds}` d'une règle, champs « au-dessus de (%) » et « pendant (s) au plus » du formulaire) : un canal qui reste au-dessus du niveau plus longtemps que la durée est tenu juste en dessous tant que ce qui le pilote ne redescend pas ; le compte repart quand il redescend. Le moteur se souvient depuis quand chaque canal est au-dessus (seul état des règles) ; comme les autres bornes, une règle verrouillée tient aussi contre les forçages.
- En v1, seul `clamp` existe ; `confirm`, `reject`, `allowCapabilities` (liste blanche) et les vitesses de pan/tilt (`rate` en °/s) restent à faire.

## Clignotement (sécurité photosensible)
- « Vérifier le show » signale les looks qui clignotent **plus de 3 fois par seconde** (seuil de la norme WCAG 2.3.1) : un éclat est une cellule qui passe du noir à l'allumé ; une attaque en fondu (≥ 0,2) ne compte pas. Un look calé sur les temps est évalué au tempo du chant le plus rapide du show (120 BPM au moins). C'est une alerte : la sortie n'est pas modifiée (`show/flashes.ts`).
- « Vérifier le show » signale aussi un look dont les **canaux bruts** (UV, strobe, machines) sont ramenés par une règle toujours active : le look ne rend pas ce qu'il dit (valeur écrite, valeur bornée, règle).
- **Strobe max (Hz)** (`maxHz` d'une règle, champ « Strobe max (Hz) » du formulaire) : le lieu ou le show choisit la fréquence ; la valeur d'un canal strobe est ramenée au réglage le plus proche qui reste sous elle (au besoin, juste hors de la plage strobe : strobe arrêté). Il ne vaut que là où la définition QLC+ donne les fréquences (capacités `StrobeFreqRange` ou `StrobeFrequency`, gardées à l'import) ; « Vérifier le show » nomme les projecteurs sur lesquels il reste sans effet, à borner par une valeur max. Aucun seuil n'est imposé par défaut.

## Marqueurs sur widgets
- **Fader** : marqueur max (trait rouge). En mode `clamp` il bute ; en mode `scale` la course est remappée de 0 au max.
- **Bouton** : **danger** (flashs, strobe : signalé en rouge partout, UI et export Ableton), **interdit à l'IA** (`manualOnly` du look), **à confirmer** (v1 : deux appuis pour allumer, voir [ui-dashboards](ui-dashboards.md)).

## Moteur et visibilité
- Chaque bornage émet un événement sur `light:rules`, avec la règle et l'origine de la commande, visible dans l'UI et expliqué à l'IA.
- **Forçage technicien** : depuis la console DMX, on peut ignorer les règles non `locked`, avec un bandeau d'avertissement et une entrée au journal.
  - v1 : les **règles verrouillées** sont réappliquées **après** les canaux forcés (étape de garde du moteur, avant le Blackout) : un forçage passe outre le show et les règles ordinaires, jamais une limite matérielle du lieu ; « pourquoi ce canal » nomme la règle qui l'a ramené.
  - Fait : les canaux forcés comptent dans `light:state` (`parked`) et l'en-tête de **toutes les pages** affiche « 🔧 N canal(aux) forcé(s) » (vers la console DMX) tant qu'ils ne sont pas relâchés ; chaque forçage figure au journal d'activité (`dmx.set`).

## MCP
`light_rules_get(selector)` (règles effectives et provenance), `light_rules_set` et `light_rules_remove`. Ressource `light://rules`. Les réponses des outils d'écriture indiquent les bornages appliqués.

## Tests
- Cascade à 3 niveaux et `locked`.
- Plage interdite remplacée par la valeur sûre, valeur minimale de type.
- Zones protégées, drapeaux de section (`manualOnly` refuse la timeline et le MCP, `noCut`, plancher).
- Scènes sans intensité, politique strobe.
- Marqueurs `clamp` et `scale`.
- Bornage d'un effet en cours.
