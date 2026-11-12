# Plan d'action pour un agent IA (reprise sans contexte)

**But de ce fichier** : permettre à n'importe quelle IA (ou à un humain) de reprendre le chantier « retours des essais avec les lyres » sans avoir assisté aux conversations précédentes. Il dit **quoi faire, dans quel ordre, où regarder, et quels pièges éviter**.

- Le détail de chaque tâche (symptôme, pistes, critères) est dans [todo.md](todo.md), numéroté **T1 à T36**. Le plan de code détaillé du premier chantier est dans [plan-t2.md](plan-t2.md). **Ce fichier-ci ne le répète pas** : il le complète.
- Contexte général du projet : [HANDOFF.md](HANDOFF.md) (à lire en premier), [../CLAUDE.md](../CLAUDE.md) (règles), puis la spec concernée dans `specs/`.
- **Dossier local non commité `docs/__NO_COMMIT__reprise/`** (s'il existe sur cette machine) : contexte complet hors dépôt (revues brutes des 14 modèles, mémoire locale de l'IA, transcript de la session, outils de revue). Lire son `README.md`. Privé : ne rien en copier dans le dépôt.
- Dernière mise à jour : 2026-11-10. **Quand tu termines une tâche, mets à jour la colonne « État » plus bas.**

## 1. De quoi s'agit-il

`light-mcp-server` est une console lumière logicielle (DMX via Art-Net, sACN et DMX USB), pilotée par interface web, MIDI, OSC, MCP et CLI. Node ≥ 22.6, TypeScript strict, ESM. Le serveur est dans `src/plugins/light/`, l'interface dans `web/src/`.

L'utilisateur vient de brancher de **vraies lyres** pour la première fois et a noté ce qui ne va pas ou manque. Les tâches T1 à T22 en sont tirées. Il joue **en Art-Net**, pas en DMX USB (T1 en attente).

## 2. Règles non négociables

1. **Réutiliser avant d'écrire.** Les outils MCP, routes HTTP, adresses OSC et la CLI sont de minces adaptateurs sur la **couche de commandes** (`src/plugins/light/commands/`, registre dans `registry.ts`). Toute nouvelle fonction commence par une commande ; l'interface vient après. Pas de duplication.
2. **Fichiers privés : préfixe `__NO_COMMIT__`.** Tout ce qui ne doit jamais être commité (mémoire d'une IA, transcripts, brouillons privés) porte ce préfixe dans son nom, où que ce soit : `.gitignore` l'exclut. Jamais de `git add -f`.
   **Confidentialité : le dépôt est public.** Aucune donnée privée de l'utilisateur dans le code, la doc, les tests, les exemples ni les commits : pas de nom de lieu, d'événement, de chant, de personne, de groupe de projecteurs propre à l'utilisateur, pas d'adresse IP, pas d'URL publique. Le privé vit dans `data/` (exclu de git). Faire un **grep de contrôle avant chaque commit** (IP, noms de lieux, noms de chants, adresses).
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
| **T3** fondu ignoré sur certains projecteurs | `engine/player.ts`, `venue/venue.ts` (chemins : canaux bruts, gradateur générique, règle) | **Fait (2026-11-08)** : poids du fondu porté par les canaux bruts (`RawWrite` : valeur, poids, look, feuille), émission unique dans `venue.toDmx`, le poids machine dose le gradateur quand la couleur ne peut pas se mettre à l'échelle (`machineFade`) ; repris les 10 et 11/11 après trois revues, voir [decisions.md](decisions.md) ; voir [todo.md](todo.md) T3 et la spec [engine-effects-timing](specs/engine-effects-timing.md). |

### Phase 1 — Gains rapides
**T7 fait** (2026-11-09), **T31 fait** (panneau de la lyre sélectionnée ; voir l'état plus bas), **T17 fait** (dossiers de looks) et **T33 fait** (gérer les dossiers ; voir l'état plus bas). **T12 fait** (2026-11-11). **T16 fait** (2026-11-11 : la veille tient). **T14 fait** (2026-11-11). La phase 1 est terminée.

### Phase 2 — Définitions saines
- **T20a (fait, 2026-11-11)** : détecter les définitions en doublon. Aujourd'hui `findDefinition` (`venue/qxf-import.ts`) prend la **première** correspondance après normalisation des noms ; l'ordre de lecture du dossier décide donc sans prévenir. Ajouter l'avertissement à `venue/patch-check.ts` et « Vérifier le show ».
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
**T10** (manette : Web Gamepad API côté navigateur ; PS5 seulement après discussion avec l'utilisateur), puis **T1** (DMX USB : `output/dmx-usb.ts`). En attente depuis le 2026-11-07 (« mesurer avant de corriger », l'utilisateur jouait en Art-Net) ; **le 2026-11-11, lot 0 fait** (Open DMX à 30 Hz, garde de 8 ms, horloge monotone) : **essai d'une heure à faire par l'utilisateur**, puis mesure seulement s'il reste des flashs.

## 7. État d'avancement (à tenir à jour)

| Tâche | État | Commit / note |
|---|---|---|
| T2 | **fait** (tests verts, commité) | [plan-t2.md](plan-t2.md) ; revu deux fois, 647 tests verts ; commit `a3d4585` sur `fix/t2-look-restart-mid-fade` ; essai sur la sortie locale fait (flash reproduit puis disparu), **pas encore sur les vraies lyres** |
| T4 | **fait** (tests verts, commité) | `FaderTrack` commun aux trois faders : rail, curseur, niveau demandé et fantôme dessinés en DOM du bas vers le haut ; range transparent pour le focus et l'assistance, pointeurs et flèches normalisés. Relevé DCA à deux lignes et dernière réponse de `group.list` gagnante conservés. Captures et mesures Chromium + WebKit à 1440 × 900 et 480 × 900, toucher Chromium ; Firefox non lancé (sandbox macOS). Reste noté dans [todo.md](todo.md) : le hub WS déconnecte un client très en retard (> 4 Mio) |
| T3 | **fait** (tests verts, commité) | poids du fondu porté par les canaux bruts (partage par feuille, octet dosé à partir de l'octet tenu, poids machine par look vers le gradateur, `machineFade` continu) ; repris après trois revues (10 et 11/11), tests échantillonnés dans `show-runtime.test.ts` ; **vérifié sur le matériel le 2026-11-11** (lyre à roue + barre LED : seule la luminosité fond, roue et gobo tiennent) — la précision est dans [todo.md](todo.md) T3 |
| T7 | **fait** (tests verts, commité) | `venue.fixture.orient` porte `invertPan` / `invertTilt` (écrits seulement quand donnés) ; cases au menu de l'appareil et au panneau d'orientation, badges X / Y au patch ; calibration résolue : pitch/roll/swap gardés, panOffset remis à 0, inversions re-mesurées ; tests [orientation](../test/plugins/light/orientation.test.ts) et DMX inversé au chemin commandes ([moving-heads](../test/plugins/light/moving-heads.test.ts)) |
| T31 (2026-11-09) | **fait** (tests verts, commité) | **Panneau de contrôle de la lyre sélectionnée** ([FixturePanel.tsx](../web/src/components/FixturePanel.tsx)) : clic sur un projecteur du plan = sélection tenue hors des modes ; pad XY de la lyre seule + « Viser » affiné à la sélection ; lumière en faders de canaux créés au premier toucher (id `panel-…`, niveau initial lu, sans `dca`, mono-canal seulement réutilisé, pan/tilt exclus) ; sections fermées par droits réels ; resynchronisation du pad sur `position.*` / `panic` / show ouvert. Périmètre dans [todo.md](todo.md) T31 ; `FaderTrack` extrait de Dashboards.tsx (web/src/components/FaderTrack.tsx) |
| T17 (2026-11-09) | **fait** (tests verts, commité) | **Dossiers de looks** : le dossier reste le tag `dossier:` (aucune commande ni migration), helpers purs [web/src/folder.ts](../web/src/folder.ts) (dossier = premier tag nommé, vide et doublons ignorés, nettoyés au premier passage) ; champ dossier dans l'éditeur (`<datalist>`, tags sans dossier, champ dédié prioritaire), sélecteur au menu clic droit (`look.get` avant `look.put`, menu ouvert en cas d'échec), liste du show groupée (une table, en-têtes dépliés par défaut, « sans dossier » dernier, groupes vides masqués, filtre aligné sur `folderOf` et remis à « Tous » si le dossier choisi disparaît) ; les deux hôtes de l'éditeur (Show, Dashboards) passent la liste des dossiers ; 4 tests UI dans app.spec.ts |
| T33 (2026-11-09) | **fait** (tests verts, commité) | **Gérer les dossiers** : commandes `show.folder.move` (looks lus entiers côté serveur, id inconnu refuse tout avant d'écrire), `show.folder.rename` (fusion possible), `show.folder.delete` (dissoudre), chaque look par `look.put` (history) ; helpers purs [show/folders.ts](../src/plugins/light/show/folders.ts) portent aussi les tags de l'import QLC+ ; UI : « ➕ Nouveau dossier… » au menu du look, clic droit de l'en-tête (renommé / dissous, confirmé), multi-sélection (⌘/Ctrl, Maj, Échap, clic simple lance toujours) par le `pick` des dashboards, drague souris/plume vers l'en-tête (seuil 8 px, accent, toucher exempt). Table plate dès le dernier dossier vide. Tests : 3 commandes et 3 parcours UI ; repris le 2026-11-10 après l'essai (bouton « 📁 Nouveau dossier… » au-dessus de la liste, dossiers vides stockés dans show.json via `show.folder.create`, Ctrl+clic mac = sélection, menu sur une ligne, sélection de texte coupée, 3 parcours UI de plus) ; toujours le 2026-11-10 : **sous-dossiers par chemin** (`show.folder.nest` par le glisser d'un en-tête, « ➕ Sous-dossier » au menu, arbre rendu indenté, filtre qui suit l'arbre), **fantôme de drague** qui suit le pointeur, dépôt sur une ligne de look = range dans son dossier, teinte d'accent et rails de branche sur les lignes membres (le chemin répété en puce retiré à l'essai) |
| T12 (2026-11-11) | **fait** (tests verts, commité) | précisé par l'utilisateur : fonction d'un canal choisie par son nom (recherche) dans l'éditeur de fader, qui règle l'intervalle du fader sur cette fonction ; [fader-functions.ts](../web/src/fader-functions.ts) |
| T16 (2026-11-11) | **fait** (tests verts) | **Instantané de démarrage** : réglage `startupSnapshot` (`show.settings.set`, `null` l'efface, effacé par `snapshot.delete`) ; rappelé au démarrage si aucune reprise après plantage récente ne l'emporte, et à `show.open`, par `recallSnapshot` (commun avec `snapshot.recall` et le Panic) ; la veille tient ; select « Instantané au démarrage » + badge « démarrage » dans la page Show ; tests [startup-snapshot.test.ts](../test/plugins/light/startup-snapshot.test.ts) et un parcours UI |
| T14 (2026-11-11) | **fait** (tests verts, commité) | thématiques de la création par intention : sélecteur à recherche et puces ([ThemePicker.tsx](../web/src/components/ThemePicker.tsx), [themes.ts](../web/src/themes.ts)), mot libre toujours permis, `label` accentué par ambiance dans la base de connaissances ; le T15 ajoutera ses intentions à la liste |
| T15 (2026-11-11) | **fait** (tests verts, commité) | intentions créées, retouchées, masquées depuis la page Show ([IntentionsManager.tsx](../web/src/components/IntentionsManager.tsx)) ; rangées dans le show ou la bibliothèque personnelle (`data/private/intentions/`) ; un `.lightshow` emporte celles de la machine que le show cite ; une seule clé (`normalizeMood`) ; voir [todo.md](todo.md) T15 |
| T15b (2026-11-12) | **codé** (tests verts, commité sur `feat/t15b-intention-ids`, pas fusionné) | ids générés `i-<base36>` pour les nouvelles intentions, libellés renommables (`aliases`), doublons de libellé permis (show > personnelle > fichier privé > livrée), une seule résolution `resolveIntention`, migration à l'écriture et au chargement, doublons d'une autre machine dits et tranchés à la restauration ; voir [todo.md](todo.md) T15b et [decisions.md](decisions.md) |
| T20a (2026-11-11) | **fait** (tests verts) | doublons de définitions détectés ([definition-duplicates.ts](../src/plugins/light/venue/definition-duplicates.ts)), avertissement dans « Vérifier le show » pour les modèles patchés dont les copies diffèrent, bibliothèque entière dans `venue.patch.check` |
| T35 (2026-11-11) | **codé** (tests verts, commité sur `feat/t35-buttons-dca`, pas fusionné) | un DCA dose la lumière de ses projecteurs quoi qu'il l'écrive (scènes brutes comprises), par ses sous-groupes, chaque DCA une fois ; un look sur le canal d'un fader lié suit son DCA ; le grand master baisse tout ; voir [todo.md](todo.md) T35 et [decisions.md](decisions.md). **Essai sur un show réel par l'utilisateur avant fusion** ; ordre imposé ensuite : T5 puis T25 |
| T21, T22, T18 | à faire | |
| T6 (2026-11-11) | **fait** (tests verts, commité sur `feat/t6-fixture-mode`) | mode DMX par le menu de l'appareil (`venue.fixture.mode`, `venue/mode-change.ts` : report par nom, lot annulable, lieu partagé : copie ou pour tous) ; mode de fonctionnement d'un canal (`fixture.channel.mode`, `venue/channel-modes.ts`, panneau, HTP) ; plages voisines du fader ; décisions T6 dans [decisions.md](decisions.md) ; **pas encore essayé sur les vraies lyres** |
| T11, T9 | à faire | T11 : le changement de mode est fait par T6 |
| T5 (2026-11-11) | **codé** (tests verts, commité sur `feat/t5-fadeable-tracks`, pas fusionné) | pistes fondables par appareil : composition canal par canal ([venue/tracks.ts](../src/plugins/light/venue/tracks.ts)), `venue.tracks.*`, « Transitions… » au menu de l'appareil ; voir [todo.md](todo.md) T5 et [decisions.md](decisions.md). Essai sur le matériel à faire |
| T25 (+ T29), T26, T24, T27 | à faire | T25 et T29 : conception à discuter avec l'utilisateur avant tout code |
| T25 lot 2 (2026-11-12) | **codé** (tests verts, commité sur `feat/t25-2-runtime`, pas fusionné) | couche Mouvement dans le moteur : réclamations dans `compose` (looks, pan/tilt bruts, manuel), `venue.readPosition`, position envoyée relue après la garde, `strictBounds` sans effet, Panic en tenue, points d'ancrage `releaseTop` / `homePositions` / `motionStatus` / `motionLock` pour les lots 4 à 6 et T26 ; ce qui change sur la sortie est listé dans la [spec moteur](specs/engine-effects-timing.md), « Couche Mouvement ». **Pas encore essayé sur les vraies lyres** |
| T13 (2026-11-11) | **fait** (tests verts, commité) | édition des canevas : `venue.canvas.edit`, refus ou adaptation des looks de pas, même contrôle pour put / versions, éditeur en fenêtre de la page Lieu ; voir [todo.md](todo.md) T13 et [decisions.md](decisions.md) |
| T20b, T8 | à faire | |
| T23, T30, T28 | à faire | T23 avant T30 ; T27 et T25 avant T28 |
| T19 | à faire | |
| T10 | à faire | en fin de parcours |
| T1 | en cours | lot 0 fait (2026-11-11) ; essai d'une heure à faire par l'utilisateur (en attente du 2026-11-07 au 2026-11-11 : il jouait en Art-Net) |

États possibles : à faire · en cours · fait (tests verts, commité) · bloqué (dire pourquoi) · en attente.

## 7 bis. Décisions déjà prises (ne pas les rediscuter)
- **T2** : un look relancé en plein fondu (A → B → A) repart de son **niveau courant** et reprend sa **position dans l'animation** (le `LookPlayer` de la queue est réutilisé, sauf look modifié ou palette changée pendant la queue ; un enregistrement à l'identique n'est pas une modification). Remplace la règle de la spec « repart à neuf depuis le noir ». Noté dans [decisions.md](decisions.md) et la spec.
- **T26** : verrou « Figer les lyres » à **deux niveaux** : souple (looks et cible bloqués, pad XY libre) et dur (tout, pad compris).
- **T24** : chaque cible a son **groupe ou sa liste de lyres** ; plusieurs cibles à la fois.
- **T10** : manette placée en fin de parcours ; PS5 (pavé tactile, gyro) seulement après discussion.
- **T1** : DMX USB mis en attente le 2026-11-07 (l'utilisateur joue en Art-Net) ; le 2026-11-11, il décide de faire le **lot 0 sans mesurer d'abord** (Open DMX à 30 Hz, garde de 8 ms, horloge monotone), puis un essai d'une heure.
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
