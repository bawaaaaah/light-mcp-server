# Tests à faire sur le Mac de régie (instructions pour un agent Claude)

Ce document s'adresse à **un agent Claude Code lancé sur le Mac de régie** de l'utilisateur, dans le dossier du dépôt. Il décrit les tests que la machine de dev (Linux, sans MIDI ni Ableton ni réseau lumière) n'a pas pu faire. Les résultats vont dans `docs/research/proto-resultats.md` (sections P1 à P8) ; tout problème trouvé est corrigé dans le code avec un test, puis commité.

## Règles à respecter
- Lire d'abord [`HANDOFF.md`](HANDOFF.md) et [`../CLAUDE.md`](../CLAUDE.md).
- **Confidentialité** : ne jamais recopier dans le dépôt (doc, code, tests, commits) de nom de lieu, d'événement, de chant ou de personne, ni d'IP réelle. Les fichiers de l'utilisateur vont dans `data/` (exclu de git). Écrire des résultats **anonymisés** (« bus IAC », « node 1 », « 8 sections »…). Faire un grep de contrôle avant chaque commit.
- **Ne jamais écraser un fichier de l'utilisateur** : travailler sur des copies (`data/private/`, `data/imports/`), en particulier pour les `.als` et `.qxw`.
- **Live fermé** pendant toute écriture de `.als` ; **QLC+ fermé** pendant les tests Art-Net (port 6454).
- Ce qui demande une action humaine (brancher un contrôleur, cliquer dans Live, regarder la lumière) : **le demander à l'utilisateur, une étape à la fois**, et attendre sa réponse.
- Répondre à l'utilisateur en français.

## 0. Préparation (agent seul)
```bash
node -v                       # ≥ 22.6
npm install
npm install-scripts approve esbuild @julusian/midi && npm rebuild esbuild @julusian/midi   # si npm ≥ 12
npm --prefix web install
npm run build
npm test                      # doit être tout vert
npx playwright install chromium && npm run test:ui   # tests de l'interface dans un navigateur
```
Noter les versions (macOS, Node, Ableton Live) dans le rapport.

## 1. P1 — MIDI local depuis Node (agent + utilisateur)
1. `npm run proto:midi -- --list` → noter le nom exact du **bus IAC** et des contrôleurs USB.
   - Si le module MIDI ne se charge pas : noter l'erreur exacte (architecture arm64/x64, prébuild), c'est un bloquant à corriger.
2. **Latence** : `npm run proto:midi -- --latency --out "IAC" --in "IAC" --count 500` (le bus IAC renvoie ce qu'il reçoit). Critère : p95 < 2 ms.
3. **Hot-plug** : `npm run proto:midi -- --watch` puis **demander à l'utilisateur** de débrancher/rebrancher un contrôleur USB. Critère : apparition/disparition signalée en ≤ 1 s.
4. **RTP-MIDI système** : demander à l'utilisateur de créer une session dans *Configuration audio et MIDI → Réseau*, puis refaire `--list` et la mesure de latence à travers elle.

## 2. P4 et P5 — horloge, position et aftertouch depuis Ableton (utilisateur dans Live)
Préalable (utilisateur) : Live → Préférences → Link · Tempo · MIDI → sur la sortie du bus IAC, **Sync** et **Track** activés.
1. Lancer `npm run proto:midi -- --in "IAC"`.
2. Demander à l'utilisateur de **lancer la lecture** : vérifier le BPM affiché (±0,5 du tempo de Live) et que la position avance.
3. Demander un **changement de tempo** : le BPM suit en moins d'un temps.
4. Demander un **saut dans l'arrangement** (clic plus loin, puis lecture) : la position affichée (mesure.temps) doit correspondre à celle de Live (SPP).
5. Demander **Stop** : « horloge : absente » ou arrêt, puis **Sync désactivé** : l'alerte « horloge absente » doit apparaître. Avec le serveur lancé et un look en temps qui joue : **le look doit continuer au dernier tempo** après Stop (il ne se fige pas), et reprendre au tempo de Live à la relecture, y compris après un saut en arrière dans l'arrangement. Noter si Live envoie l'horloge quand il est arrêté.
6. **P5** : demander de jouer un clip contenant de l'**aftertouch** (enveloppe de pression) : des lignes `polyAT`/`chanAT` doivent apparaître entre note on et note off. Si Live n'en émet pas, le noter (le mode Momentané fonctionne alors sans « suivre l'aftertouch »).

Astuce : si AbleSet est installé, `/midi/send/...` en OSC (port 39051) permet d'injecter des notes sans clip ; l'utilisateur a déjà un client de ce type dans son espace de travail privé.

## 3. P7 — RTP-MIDI intégré au serveur (agent + utilisateur)
1. `npm run proto:rtp -- --bench` → noter p50/p99.
2. `npm run proto:rtp -- --listen --port 5004` puis demander à l'utilisateur : *Configuration audio et MIDI → Fenêtre → Configuration du réseau MIDI → Annuaire « + » → 127.0.0.1 port 5004 → Connecter*, et de router une piste MIDI de Live vers cette session.
3. Critères : « session connectée » affichée, notes reçues, horloge suivie si Sync est activé sur cette destination.

## 4. P3 et P8 — rack et Live Set (agent prépare, utilisateur ouvre dans Live)
1. Demander à l'utilisateur d'exporter depuis Live **un MIDI Effect Rack à une seule chaîne** (la « coquille ») et de le copier dans `data/private/shell.adg` (ou utiliser celui de son espace de travail privé).
2. `npm run proto:adg -- --shell data/private/shell.adg` → `prototypes/out/test-rack.adg`.
3. Demander à l'utilisateur de le glisser sur une piste MIDI : vérifier **ouverture sans erreur, 6 chaînes nommées, key zones d'une seule touche (éditeur de zones), couleurs, et qu'une note de clip allume la bonne chaîne**.
4. Copier un Live Set de travail (jamais l'original) dans `data/private/test.als`, Live **fermé**, puis :
   `npm run proto:liveset -- --als data/private/test.als --track "<nom exact d'une piste MIDI qui a déjà un clip>"`.
5. Demander à l'utilisateur d'ouvrir `prototypes/out/test-set.als` : **pas de plantage** (y compris 1 minute après l'ouverture), repères Chant A/B/C + STOP, 9 clips nommés avec leur note, paliers de tempo 72/128/96.
6. Si Live plante : récupérer le rapport (`~/Library/Logs/DiagnosticReports/Live-*.ips` et `~/Library/Application Support/Ableton/Live Reports/`), comparer avec les causes connues (clips « fenêtrés », `TakeId` dupliqués : voir `research/retour-experience-utilisateur.md`).

## 5. P6 — découverte Art-Net (sur le réseau lumière, QLC+ fermé)
1. `npm run proto:artnet -- --seconds 5` (éventuellement `--interface en0`).
2. Critères : chaque node répond (IP, nom, sorties/port-addresses). Noter les résultats **anonymisés**.
3. Puis `npm run serve` et page **Réglages** : les nodes apparaissent, la sortie compte des paquets.

## 5 bis. Bascule avec QLC+ (agent + utilisateur, sur le réseau lumière)
Suivre [`bascule-qlc.md`](bascule-qlc.md) en répétition, et noter :
1. **Partage du port 6454** sur le même Mac : lancer QLC+ (sortie Art-Net active), puis le serveur avec la découverte **active**. QLC+ envoie-t-il toujours ? La page Réglages indique-t-elle « découverte unavailable » ? Puis dans l'ordre inverse (serveur d'abord, puis QLC+) : QLC+ arrive-t-il à ouvrir sa sortie Art-Net ? Si un ordre pose problème, garder `"discovery": false` sur ce Mac (recommandation actuelle) et le noter.
2. **Comportement du node** quand les deux envoient : fusion HTP ou LTP, durée de maintien d'une source muette (couper QLC+ et chronométrer), bit de fusion vu dans Réglages (si découverte active).
3. **Bascule complète** dans les deux sens pendant qu'Ableton joue : pas de noir, pas de saut ; temps total.
Résultats anonymisés dans `research/proto-resultats.md` (section P6).

## 6. Reprise du show réel et auto-test (agent, puis utilisateur pour regarder la lumière)
1. Copier les définitions de fixtures de l'utilisateur dans `data/fixtures/` :
   `cp ~/Library/Application\ Support/QLC+/Fixtures/*.qxf data/fixtures/` (et celles de la bibliothèque QLC+ si besoin).
2. Copier son workspace dans `data/imports/` (copie !).
3. Définir les PIN : `npm run light -- pin regisseur <pin>` et `npm run light -- pin admin <pin>`.
4. `npm run serve`, ouvrir `http://localhost:8790`, page **Import** : proposition → vérifier les avertissements (définitions manquantes = 0 attendu) → **Appliquer** → **Reconstruire** (proposition) → **Auto-test**.
   Critères : auto-test 100 % des mappings, exclusivité OK, latence max < 10 ms. Puis l'auto-test avec **« Mesurer aussi la cadence »** : toutes les lignes ✔ (comparer avec la mesure de cadence de son propre banc de test).
5. Avec le node Art-Net et le vrai kit (QLC+ fermé), demander à l'utilisateur de **regarder** : chaque section lancée depuis la page Live correspond-elle visuellement à QLC+ ? Le Panic, le Blackout, les masters ?
6. **Plantage simulé** : un look qui joue, arrêter le serveur (Ctrl-C) et le relancer aussitôt : la lumière revient telle quelle en quelques secondes (message « Reprise après redémarrage » dans le terminal).
7. **Avec Ableton** (profil MIDI « local », bus IAC) : demander à l'utilisateur de jouer sa setlist ; les sections doivent suivre les clips, et la reprise au milieu d'une section (scrub) doit rallumer la bonne section quand « Suivre la position MIDI » est actif.

## 6 bis. Réimporter le vrai show (après les mises à jour du 2026-10-15)
Les faders QLC+ hors gradateur (blanc, UV, strobe, machines) deviennent maintenant des **faders de canaux**, et les Submasters des DCA. Réimporter le workspace **sans `--replace`** : `npm run light -- import qxw data/imports/<copie>.qxw` (proposition), puis `--apply`.
- Le rapport « Fusion avec le show existant » doit montrer des faders de canaux **ajoutés**, les looks **identiques** (ou mis à jour si le workspace a changé), et rien de retouché à la main écrasé (liste « conservés »).
- Les looks importés avant ce suivi et différents apparaissent « à vérifier » : ils sont conservés.
- Relancer l'auto-test (avec la cadence) : 100 % attendu ; vérifier dans la page Show que les faders de canaux listent les bons canaux.
- Définitions : copier dans `data/fixtures/` les `.qxf` du dossier personnel de QLC+ (`~/QLC+/Fixtures` sur l'ordinateur de l'utilisateur, ou l'équivalent sur le Mac) **et** ceux fournis avec QLC+ (`/Applications/QLC+.app/Contents/Resources/Fixtures/`, sous-dossiers par fabricant) pour les modèles qui manquent encore. Le gradateur « Generic » est connu sans `.qxf`. Un mode de nom différent mais de même nombre de canaux est retenu (signalé). Attendu : **aucune** « définition manquante » (vérifié sur les workspaces de l'utilisateur avec ces deux sources).
- Les séquences sans couleur (fumée, hazer) deviennent des looks « machines » à canaux bruts, lancés par les mêmes notes : vérifier avec l'utilisateur qu'une note de fumée envoie bien la fumée.
- Page Show, « + Nouveau fader de canaux » : créer un fader sur le canal strobe (ou UV) de plusieurs projecteurs ; le mapper sur un CC (page MIDI) et vérifier avec l'utilisateur qu'il règle tous ces projecteurs ensemble.

## 6 ter. Programmes de règles depuis Ableton
1. Copier un clip MIDI de Live (par exemple le clip « A #100 » de la piste « Show TAG ») dans `data/private/shell.alc` (copie !).
2. Créer un programme « Prière » avec Program Change #100 et une règle « max 40 % » attachée (page Lieu, « Règles et limites »), puis `npm run light -- export programs`.
3. Demander à l'utilisateur de glisser `data/exports/programmes/priere-100.alc` dans Live (Live fermé n'est pas nécessaire pour un clip) : **le clip s'ouvre sans erreur** ? Le lancer : le programme « Prière » devient actif dans l'en-tête de l'interface.
4. `npm run light -- export mid --song <id>` puis glisser le `.mid` sur une piste MIDI : les notes des looks sont-elles là au bon endroit ? **Les Program Change sont-ils conservés par Live** (à noter : on pense que non) ?
5. Si non : page MIDI, nouveau mapping sur une note, action « Activer un programme de règles » ; une note dans un clip Live active alors le programme.
6. Une section sans programme **garde** le programme actif (choix de l'utilisateur) : le vérifier en lançant la section qui suit « Prière ».

## 6 quater. Essais des ajouts du 2026-10-21 et 22 (agent prépare, utilisateur regarde)
Avant chaque essai qui allume : `npm run light -- call output.status` (veille ?) et prévenir l'utilisateur. Rien ici ne demande de fermer QLC+ ou Live, sauf mention.

1. **Sortie vers le node** : Réglages → Sortie DMX. Aucune ligne « aucun node vu ne sort cette adresse » ; le port Art-Net du node montre « DMX en sortie ». Lancer un look **sans machine** et demander à l'utilisateur si les projecteurs branchés sur ce port s'allument comme prévu. Pour le port sACN : régler un univers en sACN (même page) et vérifier de même. Résultats anonymisés (« node 1, port 2 »).
2. **Machines et sélecteurs** : avec la machine à bulles/brume branchée, lancer un look qui colore ses LED : **ni bulles, ni fumée, ni ventilation** ne doivent partir (Console DMX, « pourquoi ce canal » : attribut « effet »). Le canal « Mode Selection » des barres LED reste à 0.
3. **Faders et DCA** : créer un fader « Bords » (Dimmer des barres extrêmes, arbre de la page Show), un fader « Centre » (Dimmer + rouge des barres centrales) et un DCA qui les dose ; les poser sur le Live et faire regarder : à 0 les barres s'éteignent, le DCA dose les deux.
4. **Tempo** : (a) widget Tap, taper un BPM : les looks suivent ; « ↺ MIDI » apparaît quand Live joue, un appui rend la main à Live. (b) 🎤 : sur une musique jouée dans la salle, le bouton passe en « suivi » en une dizaine de secondes, BPM juste à 1 près. (c) **Horloge en sortie** : seulement avec l'accord de l'utilisateur, une piste de Live réglée pour suivre une horloge externe sur un port qui n'est **pas** une entrée surveillée ; Live prend le tempo de la lumière.
5. **DJ (OS2L)** : VirtualDJ sur un ordinateur du réseau (ou celui-ci) ; dans ses réglages OS2L, la régie « Lumière » apparaît d'elle-même (sinon `os2lDirectIp` = adresse de Réglages → DJ (OS2L)). Le tempo de la régie suit le morceau (Live arrêté) ; un bouton du pad nommé comme un look le lance ; un curseur mappé (page MIDI, Source : DJ) règle un DCA.
6. **AbleSet** : lancer AbleSet ; page MIDI → « Suivre AbleSet » : chant et section s'affichent. Un chant du show au **même titre** qu'un chant de la setlist, ses sections aux **mêmes noms** : en lecture, chaque section lance la sienne (pas en doublon avec des notes MIDI qui lancent les mêmes sections : les désactiver pour l'essai). Page Chants, « ⇥ AbleSet » envoie AbleSet sur le chant.
6 bis. **Ableton Link** : Live ouvert, Link activé dans ses préférences ; page MIDI, « Le tempo suit » → Ableton Link : « 1 pair(s) entendu(s) » et le BPM de Live ; changer le tempo dans Live, la lumière le suit. Dans la seconde, « temps alignés » s'ajoute (`link.status` : `phase: true`) ; lancer un look au temps (flash) et le métronome de Live : les deux tombent ensemble, à l'oreille et à l'œil (la mesure, le « 1 », peut être décalée : attendu). Si aucun pair n'est vu, ou jamais « temps alignés », le noter : le format des annonces ou des mesures serait à revoir (`src/plugins/light/link/link.ts`).
6 ter. **DMX USB** : seulement avec l'accord de l'utilisateur, QLC+ sans sortie USB ouverte ; brancher l'interface USB (celle du workspace QLC+, puce FTDI) et des projecteurs sur sa ligne. Réglages → Routes → « ↻ Chercher les interfaces » : elle apparaît (`/dev/cu.usbserial-…`). Un univers **libre** (pas celui des nodes) → cocher DMX USB, type **Open DMX** (FT232R) ; « Interfaces DMX USB » : « envoie » et un compteur qui monte (~40 par seconde). Lancer un look : les projecteurs de la ligne USB suivent, **sans scintillement**. Débrancher : l'erreur s'affiche ; rebrancher : « envoie » revient seul. Si rien ne sort en Open DMX, essayer **USB Pro** (et l'inverse) et noter lequel marche. Mettre en veille : QLC+ peut rouvrir l'interface.
7. **Interface** : sur la tablette, mode édition d'un dashboard chargé : la bande hachurée à droite fait défiler ; un menu du clic droit (appui long) tient dans l'écran ; après un déploiement, le bandeau « nouvelle version » propose de recharger.
8. Noter ce qui marche et ce qui ne marche pas, anonymisé, dans `docs/research/proto-resultats.md`.

## 7. Rapport
- Compléter `docs/research/proto-resultats.md` (tableau de synthèse + une section par prototype, résultats anonymisés).
- Mettre à jour `docs/HANDOFF.md` (« Où on en est ») et `docs/roadmap.md` (avancement).
- Corriger les problèmes trouvés (avec tests), commiter avec un message clair, et faire un résumé en français à l'utilisateur : ce qui marche, ce qui ne marche pas, ce qui reste à décider.
