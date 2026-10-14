# Règles et limites (garde-fous)

Une seule mécanique gère toutes les limites : max par attribut, modes interdits, zones protégées, marqueurs de widgets, sécurité des sections. Le **masque de règles** est la **dernière étape du moteur** avant la conversion DMX : aucune source ne le contourne, ni un effet, ni la timeline, ni l'IA.

## Principes
- **Pas de règle = liberté totale.** Aucune limite sur le choix des couleurs par défaut.
- Une règle porte sur un **attribut** ou une **capability** (plage de valeurs d'un canal).
- L'UI affiche toujours la **règle effective et sa provenance**, par exemple : « UV max 40 %, défini sur le type *Barre LED X*, surchargé par le groupe *Parvis* ».

## Périmètre
| v1 | Plus tard |
|---|---|
| Cascade à **3 niveaux** ; zones protégées ; drapeaux de section ; scènes sans intensité par défaut ; politique strobe ; marqueurs | Cascade complète (niveaux rôle, zone, instance, section) ; `appliesTo` différencié pour l'IA en live |

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

## Toujours actifs en v1 (hors cascade)
- **Zones protégées** : une zone marquée `protected` (pupitre, public) a ses propres limites. Par exemple « intensité ≤ 60 % vers *audience* », « aucune lyre ne vise *pupitre* sauf look autorisé ».
- **Drapeaux de section** (posés sur une section de chant, actifs pendant cette section) :
  - `manualOnly` : jamais déclenchée par la timeline ni par l'IA, au doigt seulement ;
  - `noCut` : seules les techniques qui n'éteignent rien sont admises ;
  - **plancher d'intensité** : « le sol n'est jamais noir » ;
  - **règles machines** : « pas de bulles pendant une prise de parole », « brume jamais au tempo ».

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
| `rate` | strobe ≤ 10 Hz, pan/tilt ≤ X°/s | borne la fréquence ou la vitesse |
| `duration` | blinder ≥ 80 % pendant 3 s au maximum | borne la durée |
| `aim` | ne jamais viser *audience* sous 2 m | interdit un angle ou une cible (via la scène) |

`onViolation` : `clamp` (défaut, on borne et on informe), `confirm` (confirmation dans l'UI) ou `reject`.

## Marqueurs sur widgets
- **Fader** : marqueur max (trait rouge). En mode `clamp` il bute ; en mode `scale` la course est remappée de 0 au max.
- **Bouton** : **danger** (flashs, strobe : signalé en rouge partout, UI et export Ableton), **interdit à l'IA**, **à confirmer**.

## Moteur et visibilité
- Chaque bornage émet un événement sur `light:rules`, avec la règle et l'origine de la commande, visible dans l'UI et expliqué à l'IA.
- **Forçage technicien** : depuis la console DMX, on peut ignorer les règles non `locked`, avec un bandeau d'avertissement et une entrée au journal.

## MCP
`light_rules_get(selector)` (règles effectives et provenance), `light_rules_set` et `light_rules_remove`. Ressource `light://rules`. Les réponses des outils d'écriture indiquent les bornages appliqués.

## Tests
- Cascade à 3 niveaux et `locked`.
- Plage interdite remplacée par la valeur sûre, valeur minimale de type.
- Zones protégées, drapeaux de section (`manualOnly` refuse la timeline et le MCP, `noCut`, plancher).
- Scènes sans intensité, politique strobe.
- Marqueurs `clamp` et `scale`.
- Bornage d'un effet en cours.
