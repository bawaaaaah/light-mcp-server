# Groupes et masters

**Vocabulaire** (décision du 2026-10-14) : le **Groupe** est l'objet (membres, sous-groupes, exclusivité, presets) ; son fader s'appelle le **DCA** (comme sur une console son). On évite « sub-master » (sens variable selon les consoles) et « fader de groupe ».

Un **objet Groupe unique** remplace les groupes de widgets, les masters de groupe, les sub-masters, les groupes d'exclusivité et les solo frames. Ce choix fait suite à l'analyse critique : sept mécanismes qui se recouvraient rendaient le « pourquoi cette lumière est à 40 % ? » illisible.

## Modèle
```
Groupe {
  id, nom, couleur, notes
  membres:        fixtures | cellules | widgets | presets d'effets | looks/sections | sous-groupes
  sélecteur?:     membres dynamiques (même format que le MCP, par ex. { type: "ledbar", role: "wash-public" })
  master?:        { niveau 0..1, courbe, mute, flash }      // optionnel : « ajouter un master »
  exclusif?:      bool                                       // un seul membre actif à la fois (radio)
  limites?:       { max, min, plage, valeurs autorisées }    // ce que le groupe a le droit d'atteindre
  presets:        { inclus: [...], exclus: [...] }           // presets d'effets dosés/coupés par le master, ou interdits
  modeBoutonParDéfaut?: Déclencher | Latch | Momentané       // pour les boutons ajoutés au groupe
}
```

- **Hiérarchie** : un groupe peut contenir des **sous-groupes**, sans cycle (l'UI les refuse). Un groupe peut avoir plusieurs parents.
- **Grand master** : le master du **groupe racine**. Réglé depuis le Live par le **widget « Grand master »** (v1, un fader : `grandmaster.set`, droit `commands:level` comme un DCA, gardé avec le show) ou par une action MIDI « Grand master (fader, CC) » ; il dose le gradateur de chaque projecteur, au-dessus de tous les DCA, et fait partie des instantanés.

## DCA (master proportionnel)
- **Calcul** : `sortie = valeur_fusion × Π(niveaux des masters de chaque chaîne de groupes jusqu'au grand master)`.
- **Exemple** :

  ```
  Grand Master
  └── Ambiance (master)
      ├── LED bar public (master)
      ├── LED bar fond (master)
      └── LED PAR (master)
  ```

  « Ambiance » à 50 % et « LED bar public » à 80 % donnent 40 % en sortie.
- **Une fixture dans plusieurs groupes** : les facteurs se multiplient. Une option par groupe permet de prendre le minimum.
- **Attribut mis à l'échelle** :
  - par défaut, l'**intensité** (dimmer, ou composantes couleur pour les fixtures sans dimmer) ;
  - en option : **UV seul**, **taille** ou **vitesse d'effet** (master de vitesse façon Wolfmix).
- **Contrôles** : fader avec courbe (linéaire ou « audio »), **mute** (on retrouve la valeur en démutant), **flash** (100 % momentané), solo en option.
- **Groupe de faders avec master** : un groupe de widgets faders peut recevoir **sur demande** un master qui met les faders du groupe à l'échelle proportionnellement. C'est la forme simple, sans hiérarchie à configurer.

## Exclusif
- Lancer un membre **relâche les autres**, quelle que soit la disposition dans l'UI. QLC+ ne gérait l'exclusivité qu'à l'intérieur d'un cadre, et laissait deux scènes allumées.
- **Comme des boutons radio** (2026-10-23, précisé par l'utilisateur) : chaque groupe exclusif est un ensemble à part ; plusieurs vivent côte à côte, et lancer un look ne relâche que les autres looks **de son groupe**, jamais ceux d'un autre groupe exclusif (groupe 1 entre eux, groupe 2 entre eux…). Depuis le Live (`look.exclusive`, `src/plugins/light/show/exclusive.ts`, pur et testé), un bouton de look appartient à **un** groupe exclusif au plus : le choisir l'ôte des autres groupes exclusifs (les groupes non exclusifs, DCA, gardent leurs looks) ; « + Nouveau groupe exclusif » en crée un, nommé « Exclusif n » (le renommer page Show) ; « aucun » le rend indépendant.
- C'est ce qui donne son sens au mode MIDI **Déclencher**.
- Les conflits hors d'un groupe exclusif sont **signalés** (`light:conflicts`).

## Limites
- **Limites du DCA** (v1) : `limits { min, max, mode }` bornent le niveau effectif du groupe, d'où qu'il vienne (interface, MIDI, OSC, IA, timeline) :
  - `clamp` (« butée », par défaut) : le fader s'arrête aux bornes ; il est affiché sur la marque (rouge au max, ambre au min) ;
  - `scale` (« course réduite ») : toute la course est ramenée entre min et max (idéal pour un fader MIDI physique) ;
  - le mute donne toujours 0 ; un **flash monte au max, jamais au-delà** (pas d'éblouissement possible) ;
  - réglage dans la page Show (« Groupes et DCA »), affichage `min–max %` sous le fader du dashboard.
- Ce que les membres du groupe ont le droit d'atteindre : max (par exemple 70 %), plage, ou liste de valeurs autorisées (par exemple seulement 0, 50 et 100 %).
- Ce sont des **règles de niveau groupe** ([rules-limits](rules-limits.md)), affichées comme un **marqueur** sur le fader du master.

## Fader de canaux (v1)
- Pour ce qui n'est pas de l'intensité : **blanc, UV, strobe, machine à fumée**… Un fader de canaux écrit directement une liste de canaux (projecteur + décalage depuis son adresse, donc **même sans définition**), le plus haut l'emporte avec le show (HTP), comme un fader « Level » de QLC+. C'est aussi le **fader désigné** de la politique strobe.
- **Sur le gradateur maître d'un projecteur à couleurs** (v1, le Dimmer d'une barre ou d'un PAR LED) : le show tient ces gradateurs à fond (les DCA les dosent), donc le plus haut l'emporterait toujours. Le fader **dose** ce gradateur : à 0 le projecteur est éteint, à fond il suit les looks ; plusieurs faders sur un même gradateur, par le plus haut. Exemple : un fader « Bords » sur le Dimmer de la première et de la dernière barre, un fader « Centre rouge » sur le Dimmer et le rouge des barres centrales. Le gradateur d'une **lampe** (bloc de puissance, gradateur générique) est sa lumière : là, le fader l'allume, comme dans QLC+. « Vérifier le show » signale un tel fader laissé à 0, avec les projecteurs qu'il éteint, pour qu'il ne reste pas en bas au début d'un service.
- Le masque de règles s'applique après (UV max, strobe…) ; Blackout l'éteint ; il démarre à 0 à l'import (un strobe ne part jamais tout seul).
- **Intervalle de valeurs** (v1, `range`, « Borne inférieure / supérieure » de l'éditeur) : comme dans QLC+, la course du fader va de la borne inférieure à la borne supérieure (en valeurs DMX) ; une machine bornée à 200 ne dépasse jamais 200, même fader à fond. L'**import** reprend les bornes des faders de niveau QLC+ (`LowLimit`, `HighLimit`, ignorées jusqu'au 2026-10-22 : un fader borné à 100 envoyait 255 à fond) ; sur des gradateurs, elles deviennent les limites du DCA en course réduite. Un show importé avant les reprend à la **réimportation**, qui garde les retouches faites à la main.
- **Éditeur** (page Show, « + Nouveau fader de canaux »), sur le modèle de la sélection de niveau de QLC+ : un **arbre** des projecteurs rangés par adresse (« U1 · 040 », nom, type), chacun se dépliant sur ses canaux (« 001:Master Dimmer », pastille de couleur, attribut, adresse DMX) à cocher un par un, la case du projecteur cochant tous les siens (partielle s'il en manque). Sur les projecteurs affichés (recherche par nom, type ou adresse de départ, ou ceux d'un groupe, sous-groupes compris) : **Tous**, **Aucun**, **Inverser**, l'**accès rapide** (intensité, couleurs, strobe, effets et macros) et **« Même canal partout »** (le même canal, par son nom, sur tous les projecteurs qui l'ont : le Strobe de toutes les barres). Un projecteur sans définition prend ses canaux par numéro.
- Pour doser des **looks** (les « fonctions » de QLC+), c'est un groupe avec DCA qui les inclut, pas un fader de canaux.
- **DCA playback** (`playback`, case « Playback » de l'éditeur de groupes) : au-dessus de 0 (et sans mute), le DCA **lance** les looks qu'il dose ; à 0 il arrête ceux qu'il a lancés (un look lancé à la main reste). C'est un fader Playback de QLC+.
- Un fader de canaux peut être **dosé par un DCA** (`dca`) : le niveau du DCA (avec ses parents) multiplie celui du fader. C'est ce que devient un Submaster QLC+ placé au milieu de faders « Level ». Le lien se fait depuis le fader (« Dosé par le DCA ») ou depuis le DCA (liste « Faders de canaux dosés » de l'éditeur de groupes) : un DCA règle ainsi plusieurs faders ensemble.
- Commandes `fader.*` ; widget « Fader de canaux » ; action MIDI « Fader de canaux (CC) ».

## Niveaux en direct
- Un DCA ou un fader bougé à la main ou au MIDI change des dizaines de fois par seconde : la valeur s'applique **tout de suite**, mais n'est écrite sur disque qu'**une fois, une seconde après** le dernier mouvement, **sans copie de sauvegarde** (c'est un état, pas une modification du show). Avant une archive et à l'arrêt, tout est écrit ; une restauration d'archive l'emporte sur une valeur en attente.

## Presets d'effets inclus ou exclus
- **Inclus** : le master du groupe **dose** ces presets (niveau ou taille) ou les **coupe** (mute).
- **Exclus** : ces presets **n'agissent pas** sur les membres du groupe. Exemple : « la face n'est jamais touchée par la palette qui tourne ».

## Moteur
Les groupes s'appliquent **après la fusion** et **avant** blackout, freeze, flash et le masque de règles ([engine](engine-effects-timing.md)).

## UI
- **Page Groupes** : arbre des groupes avec glisser-déposer, membres, sélecteur, options master, exclusif, limites et presets.
  - v1 (page Show, « Groupes et DCA ») : créer, modifier, supprimer un groupe ; membres par cases à cocher (projecteurs, sous-groupes, looks), DCA oui/non, exclusif, looks dosés ou exclus ; limites du DCA dans le tableau. Plus tard : arbre et glisser-déposer, sélecteur par rôle ou tags dans l'interface.
- **Supprimer sans casser** : le résumé d'un groupe compte aussi les **faders de canaux** dont il est le DCA (un DCA sans membre n'est pas vide pour autant). Supprimer un look, un groupe ou un fader de canaux encore utilisé (sous-groupe, DCA d'un fader, mapping MIDI, dashboard, instantané, chant, secours) est **refusé** avec la liste des endroits ; l'interface la montre et ne force la suppression (`force: true`) que sur un « oui » donné en connaissance de cause. `show.references` dit où un objet sert ; « Vérifier le show » signale les looks, groupes et faders qui portent le **même nom** (un workspace QLC+ a souvent plusieurs « Master » distincts), et les mappings MIDI de même libellé qui visent des cibles différentes.
- **Widget « fader de groupe »** : le niveau propre et, en grisé, le **niveau effectif** (avec les parents), plus mute et flash.
- **Console DMX** : un clic sur le numéro d'un canal dit **pourquoi il a sa valeur** (`dmx.explain`, aussi pour l'IA) : projecteur et canal, grand master et DCA qui dosent le projecteur (niveau propre et effectif), faders de canaux et looks à canaux bruts qui l'écrivent, règles qui l'ont borné sur la dernière trame, forçage depuis la console ; relu chaque seconde tant que le panneau est ouvert.
- Dans un dashboard, une sélection de widgets se regroupe en un clic, et on peut ajouter un master si l'on veut.

## MIDI, OSC, MCP
- Niveau, mute et flash sont mappables en MIDI (CC, ou note en mode Momentané), avec retour de position. En OSC : `/light/group/{id}/level f`, `/mute`, `/flash`.
- Outils MCP : `light_group_create`, `light_group_set_members`, `light_group_set`, `light_group_level`, `light_group_tree`.

## Tests
- La cascade de l'exemple ci-dessus, et une fixture dans deux groupes (produit, ou minimum en option).
- Refus des cycles, sélecteur dynamique.
- Exclusivité et détection de conflits.
- Limites, presets inclus ou exclus.
- Masters de vitesse et de taille.
