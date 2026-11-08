# Plan détaillé de T2 — plus de flash en changeant vite de look

> Statut (2026-11-08) : **fait et revu**, tests verts (`npm test`, `npm run typecheck`), commité sur `fix/t2-look-restart-mid-fade` (`a3d4585` pour le correctif, un second commit pour les docs). Essai sur la **sortie locale** (`127.0.0.1:16454`, vrai moteur, vrais paquets ArtDmx, faux node) : fait, voir la section « Vérification ». **Pas encore essayé sur les vraies lyres.**
> Mesures (tests de caractérisation, échantillonnage 20 ms) : avant correctif, A→B→A jetait la queue de A (rouge 215 → 0 en une trame), la relance depuis `releasing` passait de 128 à 0, deux relances en moins de 100 ms de 255 à 0, et l'animation repartait au pas 0 ; après correctif, tous les sauts retombent sous la borne de continuité et les sommes restent dans les bornes.

## Contexte
Notes de l'utilisateur (2026-11-07) : « si je change trop vite entre les scènes, je peux avoir un flash, lié à la transition entre les looks (temps de montée/descente) ». Tâche T2 de `docs/todo.md`, phase 0 de `docs/plan-agent.md`. Le DMX USB est écarté (l'utilisateur joue en Art-Net), donc ce flash vient du moteur, pas de la sortie.

## Cause trouvée (lecture du code, à confirmer par mesure)
Le comportement est même **documenté comme voulu** dans `docs/specs/engine-effects-timing.md` (« Un seul chemin… », ligne ~88) : *« Relancer A pendant la transition le repart à neuf (depuis le noir, avec son propre fondu d'entrée) et le retire de dessous B : son poids de queue tombe d'un coup. »*

Dans `src/plugins/light/show/runtime.ts`, `go(lookId)` (~l. 279) :
- `this.releasing.delete(lookId)` : la copie de A qui s'éteint (exitFade) disparaît d'un coup ;
- `this.leaveCrossfades(lookId)` (~l. 389) : la queue de A sous le croisement de B disparaît d'un coup ;
- A repart ensuite avec un **nouveau `LookPlayer`** et un poids d'entrée de **0** (ou à 100 % sans fondu).

Donc A → B → A rapide : le poids total chute (creux sombre, ou saut de teinte) puis remonte, ce qui se voit comme un flash. Le test existant `show-runtime.test.ts:298` (« starting A again during the crossfade starts it fresh… ») fige ce saut : A passe à `[255, 0]` immédiatement.

## Décision de l'utilisateur
A relancé en plein fondu **repart de son niveau courant et reprend aussi sa position dans l'animation** (pas de retour au pas 0). Cela remplace la règle de la spec ci-dessus.

## Approche

### 1. Mesurer d'abord (tests de caractérisation, qui doivent échouer avant le correctif)
Dans `test/plugins/light/show-runtime.test.ts` (helpers `setup()` et `pair()` déjà là ; temps injectable via `advance(beats)`, 1 beat = 500 ms), ajouter un petit utilitaire d'échantillonnage : avancer par pas de 20 ms (`advance(0.04)`), relever le DMX à chaque pas, vérifier :
- **continuité** : l'écart d'un canal entre deux échantillons ≤ pente maximale du lissage (smoothstep : 1,5 / durée) × 20 ms + marge ;
- **pas de creux** : la somme des canaux ne passe jamais sous min(avant, après) − marge ;
- **pas de dépassement** : aucun canal au-dessus du max des deux looks.
Scénarios : A → B → A (relance à 25 %, 50 %, 75 % du croisement, entrées 1 s et 2 s) ; A → B → C → A ; A seul avec exitFade stoppé puis relancé (copie `releasing`) ; B relancé après A ; deux relances en moins de 100 ms.
Noter les chiffres obtenus dans la description du commit.

### 2. Correctif dans `show/runtime.ts`
- **Poids de queue.** Avant de les retirer, lire le poids courant de A : `outWeight(o, now)` si A est dans l'`outgoing` d'un croisement, `1 − ease(t)` si A est dans `releasing` (somme si plusieurs entrées).
- **Poids de départ de l'entrée.** Ajouter `from` à l'interface `Crossfade` ; `inWeight` devient `from + (1 − from) · ease(progression)`. Étendre `beginCrossfade` pour fixer `from`. Cas sans autre look libéré (relance depuis `releasing` seul) : créer un croisement à `outgoing` vide pour porter ce `from`, au lieu de la « entrée depuis le noir ».
- **Position dans l'animation.** Réutiliser le `LookPlayer` de la queue (celui de `Leaving` ou de `ReleasingLook`) au lieu d'en construire un neuf, **seulement si le look n'a pas été modifié** depuis (comparer `JSON.stringify(look)` de la queue et du look courant ; sinon reconstruire, comme aujourd'hui pour un look édité en direct). Ne pas rappeler `player.start()` dans ce cas.
- **`entryFade` = 0** : coupure nette inchangée (réglage voulu), mais le `player` reste continu.
- `leaveCrossfades` garde son rôle pour la **suppression** d'un look (là, la queue doit bien tomber) : lui donner deux modes (« reprendre » / « supprimer ») plutôt que de dupliquer.
- Garder intacts : la mise de côté de `strictBounds` (~l. 676-693, qui sauve et restaure `releasing` et `crossfades`), `stopAll` / `resetLive`, la protection des canaux bruts (coupés à l'arrêt), les moves de la queue.

### 3. Tests existants et nouveaux
- Remplacer l'attente du test `:298`, **en changeant son scénario** : `pair({ b: { entryFade: 2 } })` donne à A un `entryFade` de 0, donc `crossfade` est faux (runtime.ts:306) et A repart à 100 % d'un coup, ce qui ne peut rien prouver. Donner à A un `entryFade` > 0 (cas des presets : entrée 1 s, sortie 0), puis A → B → A : après `advance(1)` et `go("a")`, la sortie est **continue** (A ≈ son poids de queue, B ≈ son poids courant) puis rejoint `[255, 0]` sur l'entrée de A.
- Ajouter : relance depuis `releasing` (continuité) ; animation qui ne repart pas au pas 0 (look à plusieurs pas, mêmes pas avant et après la relance) ; look modifié entre-temps → repart à neuf ; `entryFade` 0 → coupure nette ; suppression d'un look en queue → la queue tombe (inchangé).
- Jouer `npm test` en entier : les ~600 tests existants dont ceux de croisement (lignes 213-540) doivent rester verts, hors la ligne modifiée.

### 4. Docs (dans le même commit, règle du dépôt)
- `docs/specs/engine-effects-timing.md` : réécrire la phrase « Relancer A… son poids de queue tombe d'un coup » (entrée « Fondu enchaîné ») : A repart de son niveau courant, garde son animation sauf look modifié.
- `docs/decisions.md` : nouvelle décision datée (2026-11-07), avec le pourquoi (flash en enchaînant vite) et ce qui change.
- `docs/HANDOFF.md` : une ligne dans l'historique ; `docs/plan-agent.md` : T2 → « fait » ; `docs/todo.md` : T2 coché.

## Précisions issues de la revue adversariale (14 modèles Ollama, 2026-11-08)
À intégrer à l'implémentation (le détail et le tri sont dans le compte rendu de la revue) :
1. **Ordre dans `go()`** : capturer le poids de A (queue de croisement et/ou copie `releasing`) et son `LookPlayer` **avant** `this.releasing.delete` et `leaveCrossfades` (runtime.ts:284-285), puis seulement retirer. `releasing` est une `Map` par look : une seule entrée ; pour les `outgoing`, **sommer puis borner à [0, 1]**.
2. **Condition du croisement** (runtime.ts:306) : aujourd'hui `leaving.length > 0 && entryFade > 0`. Elle doit aussi être vraie quand A a un poids de queue > 0 et `entryFade` > 0, même sans look libéré (croisement à `outgoing` vide qui porte `from`).
3. **Player réutilisé** : ne pas appeler `player.start()` (runtime.ts:313) ni `build()` dans ce cas ; sinon l'animation repart au pas 0. Détection d'une édition du look : **comparer d'abord la référence de l'objet `Look`** (O(1)) plutôt que `JSON.stringify` (fragile et coûteux) ; en cas de doute, reconstruire (comportement actuel). À vérifier au début : ce que renvoie `looks.get` après un `put`.
4. **Bornes** : borner `from` dans [0, 1] et le résultat de `inWeight` à 1. Ne **pas** plafonner `from` à 0,5 (proposé par un modèle, faux). Durées égales : la somme des poids reste 1 ; durées différentes (A entrée 1 s, B sortie 3 s) : la fusion existante partage la cellule (÷ somme, jamais plus clair que le plus clair), à **prouver par un test** avec les deux durées et sous `looksMerge` `last` **et** `highest`.
5. **`entryFade` = 0** : pas de croisement, donc saut de `from` à 1 (réglage de l'utilisateur) ; le player, lui, reste continu. À tester explicitement.
6. **Tests supplémentaires** : un look à plusieurs pas, pour **séparer** le saut de poids du saut d'animation ; relance depuis `releasing` seul ; plusieurs queues du même look (somme bornée) ; `go("a") → stopAll → go("a")` (rien d'un état mort).
7. **`strictBounds`** : il construit son propre player par `build()` et sort tôt si le look est déjà actif (runtime.ts:658) ; il ne doit **pas** passer par le chemin de réutilisation.

## Fichiers critiques
- `src/plugins/light/show/runtime.ts` : `go`, `leaveCrossfades`, `beginCrossfade`, `inWeight`, `startFadeOut`, interface `Crossfade`.
- `src/plugins/light/engine/player.ts` : `LookPlayer` (réutilisé, `start` non rappelé) ; `ease`.
- `test/plugins/light/show-runtime.test.ts`.
- `docs/specs/engine-effects-timing.md`, `docs/decisions.md`.

## Vérification
1. `npm test` et `npm run typecheck` verts ; les nouveaux tests d'échantillonnage échouent avant le correctif et passent après.
2. Grep de confidentialité sur le diff ; indexation **par chemin explicite**.
3. Essai réel, **seulement avec la sortie en veille** (`output.status`) ou sur la sortie locale 127.0.0.1 : suivre l'aperçu de la scène en direct en enchaînant vite deux looks avec fondu d'entrée de 1 s. Sur le matériel, ne rien jouer sans l'accord de l'utilisateur.
4. Dire clairement ce qui n'a pas été vérifié sur de vraies lyres.

### Essai sur la sortie locale (2026-11-08)

Montage : un vrai `LightPlugin` (moteur et ticker réels, définition de test `test/fixtures/bar4.qxf`), sortie liée à `127.0.0.1`, route vers un faux node Art-Net sur `127.0.0.1:16454` ; aucun paquet ne quitte la machine. Deux looks `plat` (rouge puis bleu) dans un groupe exclusif, fondu d'entrée 1 s, puis A → B à 500 ms → A à 600 ms. 50 trames ArtDmx capturées (44 Hz), canal rouge du premier projecteur :

| | Avant correctif | Après correctif |
|---|---|---|
| Canal rouge | … 141, 149, **156 → 0**, 1, 2, 4 … (chute de 156 à 0 en une trame, puis nouvelle montée depuis 0) | … 149, 156, 161, **163, 171, 179** … jusqu'à 255, sans retour en arrière |
| Plus forte chute sur une trame | −156 | −1 (arrondi) |
| Animation | repart au premier pas | continue sa course (une seule montée) |

Cela reproduit le flash décrit par l'utilisateur, puis montre qu'il a disparu sur le chemin de sortie réel (encodage ArtDmx compris). Ce qui reste non vérifié : les vraies lyres, leur réponse optique et un réseau de scène réel. Le script d'essai était jetable (fichier `__NO_COMMIT__`, supprimé après mesure).

## Hors périmètre
T3 (fondu ignoré sur certains projecteurs) et T4 (fader DCA) : mêmes zones de code, mais traités après T2. Si la mesure montre un autre flash (par ex. une fusion `highest` qui dépasse), le noter dans `todo.md` plutôt que d'élargir ce lot.
