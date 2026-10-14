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
- **Grand master** : le master du **groupe racine**.

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

## Presets d'effets inclus ou exclus
- **Inclus** : le master du groupe **dose** ces presets (niveau ou taille) ou les **coupe** (mute).
- **Exclus** : ces presets **n'agissent pas** sur les membres du groupe. Exemple : « la face n'est jamais touchée par la palette qui tourne ».

## Moteur
Les groupes s'appliquent **après la fusion** et **avant** blackout, freeze, flash et le masque de règles ([engine](engine-effects-timing.md)).

## UI
- **Page Groupes** : arbre des groupes avec glisser-déposer, membres, sélecteur, options master, exclusif, limites et presets.
- **Widget « fader de groupe »** : le niveau propre et, en grisé, le **niveau effectif** (avec les parents), plus mute et flash.
- **Console DMX** : au survol d'un canal, la liste des groupes qui le réduisent et de combien.
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
