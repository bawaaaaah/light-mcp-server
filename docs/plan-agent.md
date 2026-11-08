# Plan d'action pour un agent IA (reprise sans contexte)

**But de ce fichier** : permettre à n'importe quelle IA (ou à un humain) de reprendre le chantier « retours des essais avec les lyres » sans avoir assisté aux conversations précédentes. Il dit **quoi faire, dans quel ordre, où regarder, et quels pièges éviter**.

- Le détail de chaque tâche (symptôme, pistes, critères) est dans [todo.md](todo.md), numéroté **T1 à T30**. Le plan de code détaillé du premier chantier est dans [plan-t2.md](plan-t2.md). **Ce fichier-ci ne le répète pas** : il le complète.
- Contexte général du projet : [HANDOFF.md](HANDOFF.md) (à lire en premier), [../CLAUDE.md](../CLAUDE.md) (règles), puis la spec concernée dans `specs/`.
- Dernière mise à jour : 2026-11-08. **Quand tu termines une tâche, mets à jour la colonne « État » plus bas.**

## 1. De quoi s'agit-il

`light-mcp-server` est une console lumière logicielle (DMX via Art-Net, sACN et DMX USB), pilotée par interface web, MIDI, OSC, MCP et CLI. Node ≥ 22.6, TypeScript strict, ESM. Le serveur est dans `src/plugins/light/`, l'interface dans `web/src/`.

L'utilisateur vient de brancher de **vraies lyres** pour la première fois et a noté ce qui ne va pas ou manque. Les tâches T1 à T22 en sont tirées. Il joue **en Art-Net**, pas en DMX USB (T1 en attente).

## 2. Règles non négociables

1. **Réutiliser avant d'écrire.** Les outils MCP, routes HTTP, adresses OSC et la CLI sont de minces adaptateurs sur la **couche de commandes** (`src/plugins/light/commands/`, registre dans `registry.ts`). Toute nouvelle fonction commence par une commande ; l'interface vient après. Pas de duplication.
2. **Confidentialité : le dépôt est public.** Aucune donnée privée de l'utilisateur dans le code, la doc, les tests, les exemples ni les commits : pas de nom de lieu, d'événement, de chant, de personne, de groupe de projecteurs propre à l'utilisateur, pas d'adresse IP, pas d'URL publique. Le privé vit dans `data/` (exclu de git). Faire un **grep de contrôle avant chaque commit** (IP, noms de lieux, noms de chants, adresses).
   - Les noms de modèles commerciaux de projecteurs sont publics et peuvent figurer dans le dépôt.
   - Les `.qxf` de `data/fixtures/` et les shows de `data/shows/` ne vont **jamais** dans git.
3. **Décisions** : une nouvelle décision va dans [decisions.md](decisions.md) **et** dans la spec concernée, jamais en annexe en fin de fichier.
4. **Langue** : doc et échanges avec l'utilisateur en **français** ; code, identifiants et commentaires en **anglais**.
5. **Style** : modules purs (codecs, calculs) séparés des entrées-sorties pour être testables sans matériel ; **le temps est injectable** (jamais `Date.now()` ni `setTimeout` en dur dans la logique testée).
6. **Tout comportement nouveau a un test.** Moteur et calculs : `test/plugins/` (mocha). Interface : `test/ui/` (Playwright).

## 3. Pièges et points d'attention

### Sécurité du matériel et du réseau
- **Ne jamais envoyer de lumière sans vérifier la sortie.** Avant `look.go`, `selftest` ou tout test qui joue, interroger `output.status` : la sortie doit être en **veille** (standby) si le réseau réel est branché. Ne pas se fier à `data/prod.log`.
- **Les tests ne doivent jamais atteindre le réseau de scène.** Les serveurs de test lient la sortie à `127.0.0.1` avec `artnetPort` 16454. Un test mal réglé a déjà émis en broadcast vers le vrai node. Si tu crées un serveur de test, copie ce réglage.
- **Canaux de sécurité des projecteurs** : `Reset` (maintenance), canaux de mode, sorties de machine (fumée, brume) ne sont **jamais** poussés à fond comme des gradateurs et ne doivent jamais être activés par un fader, un look ou une règle sans intention explicite. Aucune tâche ne doit affaiblir cette protection.
- Strobe : ne pas toucher aux limites de sécurité (clignotements > 3 par seconde signalés, règles verrouillées).

### Comportements voulus : ne pas les « corriger »
- **Un CC MIDI en mode bascule (toggle) bascule à chaque valeur reçue**, même 0. C'est voulu : certains appareils n'envoient que CC127. Ne pas le signaler comme bug, ne pas le refaire sur des fronts.
- **Un Program Change en latch bascule dans tous les modes sauf « Déclencher »** : un PC n'a pas de relâchement. Voulu aussi.
- **Exclusivité des groupes** : « comme des boutons radio » ; chaque groupe exclusif ne relâche que ses propres looks. Voulu.
- **Un look partiel est refusé par `look.put`** : lire le look entier avec `look.get` avant de le modifier. `look.list` est volontairement résumé.

### Sécurité de l'accès
- **Le jeton maître ne doit jamais apparaître dans une URL** (ni `#token=…` dans un message, une doc ou un log) : les erreurs d'outils renvoient les URL, et il a déjà fuité ainsi.
- Ne jamais écrire l'adresse publique du serveur dans le dépôt.

### Git
- **Ne jamais faire `git add -A` ni `git add .`** : des fichiers de travail non branchés ont déjà été embarqués dans un commit poussé. Indexer **par chemin explicite**.
- Format des commits (convention de l'utilisateur, gitmoji + Conventional Commits) : `<emoji unicode> <type>(scope): <message anglais, impératif, minuscule, sans point>`, corps = le **pourquoi**. Un seul emoji par commit. Ex. : `🐛 fix(engine): keep the running level when a look is restarted mid-fade`. Ajoute la ligne `Co-Authored-By:` de ton propre modèle en pied.
- Ne pas pousser ni créer de PR sans demande de l'utilisateur.

### Données de test
- Les définitions de `data/fixtures/` sont des fichiers `.qxf` de l'utilisateur, parfois **générés d'après un manuel par une IA** : ne leur fais pas une confiance aveugle (voir T20/T21 sur le Wash). Pour les tests du dépôt, utilise `test/fixtures/` ou crée des définitions minimales.

## 4. Commandes

```bash
npm test               # mocha + tsx (backend)
npm run typecheck
npm run build:web      # interface (nécessaire avant test:ui)
npm run test:ui        # Playwright, tout le parcours web
npm run light -- <commande>   # CLI : check, selftest, call, show, backup, standby…
npm run serve          # serveur local ; ne PAS le lancer avec la sortie réelle active
```

Avant de déclarer une tâche finie : `npm test`, `npm run typecheck`, et `npm run test:ui` si l'interface a bougé. Dire honnêtement ce qui n'a pas pu être vérifié (matériel absent, par exemple).

## 5. Méthode de travail recommandée

Pour chaque tâche :
1. Lire l'entrée dans [todo.md](todo.md) et la spec liée.
2. **Reproduire** d'abord (test qui échoue) pour un bug ; écrire le critère de réussite pour une nouveauté.
3. Chercher l'existant (`grep` des commandes, sélecteurs, utilitaires) avant d'écrire.
4. Implémenter côté **commande**, puis adaptateurs (MCP, HTTP, OSC, CLI), puis interface.
5. Tests, typecheck, grep de confidentialité.
6. Mettre à jour : l'état ci-dessous, [todo.md](todo.md) si le périmètre change, [HANDOFF.md](HANDOFF.md), la spec, [decisions.md](decisions.md) s'il y a eu une décision.
7. Un commit par but, indexé par chemin.

## 6. Plan, phase par phase, avec points d'entrée

Les chemins sont des **points de départ** relevés le 2026-11-07, à vérifier (`grep`) avant de s'y fier.

### Phase 0 — Jouer proprement (priorité absolue)
| Tâche | Où regarder | Piège |
|---|---|---|
| **T2** flash en changeant vite de look (**plan complet et revu : [plan-t2.md](plan-t2.md), commencer par là**) | `src/plugins/light/engine/player.ts` (fondu d'entrée/sortie, « crossfade » avec le groupe exclusif), `src/plugins/light/show/runtime.ts`, `show/exclusive.ts` | Le look entrant et le sortant doivent partir de la valeur **courante**, jamais de 0 ni de la cible. Test à temps injectable : A → B → A en 100 ms, fondu 2 s, la sortie ne dépasse jamais max(A, B) et ne retombe pas à 0. |
| **T4** fader DCA + lissage | `engine/glide.ts`, `web/src/pages/Dashboards.tsx`, `show/model.ts` (limites min/max des DCA, `light:glide`) | Écart entre valeur affichée, valeur envoyée et course (limites). Reproduire en Playwright avant de corriger. |
| **T3** fondu ignoré sur certains projecteurs | `engine/player.ts`, `venue/venue.ts` (chemins : canaux bruts, gradateur générique, règle) | Corriger dans la couche moteur commune, pas par un cas particulier. |

### Phase 1 — Gains rapides
**T7** (inversion pan/tilt : `orientation.invertPan` / `invertTilt` existent déjà, voir `venue/orientation.ts`, à exposer dans le patch, l'aperçu et `venue/aim.ts`), **T12**, **T17**, **T16**, **T14**. Pour T16, trancher avec l'utilisateur si l'instantané de démarrage passe outre la sortie en veille ; par prudence **non** tant qu'il n'a pas répondu.

### Phase 2 — Définitions saines
- **T20a** : détecter les définitions en doublon. Aujourd'hui `findDefinition` (`venue/qxf-import.ts`) prend la **première** correspondance après normalisation des noms ; l'ordre de lecture du dossier décide donc sans prévenir. Ajouter l'avertissement à `venue/patch-check.ts` et « Vérifier le show ».
- **T21** : têtes et zones. `venue/venue.ts` prend la première occurrence de chaque composante quand il n'y a pas de `<Head>` ; les zones suivantes ne reçoivent jamais la couleur. Déduire les têtes par suffixe numérique.
- **T22** : contrôles de patch supplémentaires (`venue/patch-check.ts`).
- **T18** : roue de couleurs. `nearestSlot` dans `venue/venue.ts`. Ignorer les doubles couleurs, distance OKLab, hystérésis. Module pur, testable.

### Phase 3 — Réglage et mouvements des lyres
**T5** puis **T6** (T5 d'abord : les modes ne se fondent pas), **T11**, **T9**.
Mouvements ([todo.md](todo.md), groupe « Mouvements des lyres ») : **T25** (revoir la gestion des mouvements via les looks, avec **T29** sous-looks) est un chantier de **conception à discuter avec l'utilisateur avant tout code** (priorité des couches et sous-look partagé reportés à ce moment) ; puis **T26** (verrou à deux niveaux), **T24** (cible 3D par groupe), **T27** (zones de visée sur le pad XY). Points de départ : `show/runtime.ts` (`manualPositions`, `moveOf`), `engine/move.ts` (`MoveSchema`), `commands/move-commands.ts` (`position.*`, `calibration.*`), `venue/aim.ts`.

### Phase 4 — Confort et contenu
**T15** (intentions : commandes `design-commands.ts`, archives `.lightshow` dans `commands/file-commands.ts`, comme les définitions embarquées au commit d2f7844), **T13**, **T20b**, **T8**, puis **T23** (triangulation), **T30** (placement par angles) et **T28** (looks par zone, motifs, aléatoire).

### Phase 5 — Visuel : **T19** (après T6 et T20b).

### Phase 6 — En fin de parcours
**T10** (manette : Web Gamepad API côté navigateur ; PS5 seulement après discussion avec l'utilisateur), puis **T1** (DMX USB : `output/dmx-usb.ts`, **mesurer avant de corriger** ; en attente tant que l'utilisateur joue en Art-Net).

## 7. État d'avancement (à tenir à jour)

| Tâche | État | Commit / note |
|---|---|---|
| T2 | **plan prêt, à implémenter en premier** | [plan-t2.md](plan-t2.md) ; plan revu par 14 modèles, corrections intégrées |
| T4, T3 | à faire | T3 : voir sa précision sur les du groupe extérieur de l'utilisateur dans [todo.md](todo.md) |
| T7, T12, T17, T16, T14 | à faire | |
| T20a, T21, T22, T18 | à faire | |
| T5, T11, T6, T9 | à faire | |
| T25 (+ T29), T26, T24, T27 | à faire | T25 et T29 : conception à discuter avec l'utilisateur avant tout code |
| T15, T13, T20b, T8 | à faire | |
| T23, T30, T28 | à faire | T23 avant T30 ; T27 et T25 avant T28 |
| T19 | à faire | |
| T10 | à faire | en fin de parcours |
| T1 | en attente | l'utilisateur joue en Art-Net |

États possibles : à faire · en cours · fait (tests verts, commité) · bloqué (dire pourquoi) · en attente.

## 7 bis. Décisions déjà prises (ne pas les rediscuter)
- **T2** : un look relancé en plein fondu (A → B → A) repart de son **niveau courant** et reprend sa **position dans l'animation** (le `LookPlayer` de la queue est réutilisé, sauf look modifié). Remplace la règle de la spec « repart à neuf depuis le noir ». À noter dans [decisions.md](decisions.md) à l'implémentation.
- **T26** : verrou « Figer les lyres » à **deux niveaux** : souple (looks et cible bloqués, pad XY libre) et dur (tout, pad compris).
- **T24** : chaque cible a son **groupe ou sa liste de lyres** ; plusieurs cibles à la fois.
- **T10** : manette placée en fin de parcours ; PS5 (pavé tactile, gyro) seulement après discussion.
- **T1** : DMX USB en attente (l'utilisateur joue en Art-Net).
- **Reportées volontairement** : priorité entre couches de mouvement (T25), sous-look partagé par deux looks (T29). Les trancher à l'attaque de ces tâches, en posant la question en français avec une recommandation.
- **T20** découpé : T20a (détecter les doublons, phase 2), T20b (le reste, phase 4).

## 7 ter. Leçons de la revue du plan T2 par des modèles locaux
Une revue adversariale de [plan-t2.md](plan-t2.md) a été faite par 14 modèles Ollama (le tri est intégré au plan). Pour en refaire une :
- **`opencode` avec outils échoue** sur ces modèles (ils lisent le dépôt sans jamais rendre de revue, délai atteint) ; passer par `ollama run <modèle> --hidethinking < prompt`, avec **les extraits de code collés dans le prompt** (numéros de ligne compris), des instructions courtes et une limite de réponse (≈ 600 mots).
- Lancer les modèles **un par un**, avec une alarme (`perl -e 'alarm 600; exec @ARGV' …`) : un modèle a tourné 73 minutes malgré le délai, un autre a produit 165 Ko de texte parasite.
- Les modèles se trompent : chaque remarque est à **vérifier dans le code** (trois « bloquants » annoncés étaient faux : `Math.max` d'un tableau vide, `strictBounds` qui supprimerait un look actif, plafonner `from` à 0,5).

## 8. Questions encore ouvertes pour l'utilisateur
Voir la fin de [todo.md](todo.md). Ne pas les trancher seul : poser la question en français, avec ta recommandation.

## 9. Ce que l'utilisateur attend d'un agent
- Réponses **en français**, claires, qui disent ce qui est fait **et ce qui n'a pas été vérifié**.
- Pas de nouvelle décision de conception sans la noter dans [decisions.md](decisions.md).
- Ne pas jouer de lumière réelle sans accord ; proposer plutôt un test sur la sortie locale (`127.0.0.1`).
