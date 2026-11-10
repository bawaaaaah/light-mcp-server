# TODO — retours des essais avec les lyres

Liste de travail issue des notes prises en utilisant le logiciel (2026-11-07), première session avec de vraies lyres.
Pour reprendre ce chantier avec une IA : voir [plan-agent.md](plan-agent.md).

Les décisions de conception qui en sortiront vont dans [decisions.md](decisions.md) **et** dans la spec concernée.
Légende : 🔴 bloquant pour jouer · 🟠 important · 🟡 confort · ⚪ plus tard. « ◐ » = déjà en partie fait.

## 🔴 Fiabilité de la sortie et du moteur

### T1 — Flashs sur la sortie DMX USB après un certain temps
- **Mis en attente (2026-11-07)** : l'utilisateur joue en Art-Net sans le DMX USB pour compenser. À reprendre quand on voudra de nouveau l'USB ; ne bloque plus.
- **Symptôme** : la dernière modification a amélioré la gestion DMX USB, mais les flashs reviennent après un moment de fonctionnement.
- **Pistes** (à mesurer avant de corriger) :
  - Open DMX : le break est cadencé par logiciel (`BREAK_MS` + `sleep` dans [dmx-usb.ts](../src/plugins/light/output/dmx-usb.ts)) : tout ce qui retarde la boucle d'événements de Node (GC, gros calculs du moteur, WebSocket) allonge ou raccourcit le break et la trame est mal lue. Le temps d'une trame DMX à 512 canaux est ~22,7 ms, soit au mieux ~44 Hz.
  - Cadence : le moteur tourne à 44 Hz (spec [output](specs/output-artnet-sacn.md)), l'utilisateur pense à 40 Hz. Vérifier que la boucle USB ne suit pas plus vite que ce que la ligne peut écouler (file d'attente qui grossit → latence puis saut).
  - Charge : quelles données sont recalculées ou poussées à chaque tick (diffs WS, aperçu de scène, `light:glide`) ? Mesurer le temps de tick et la gigue sous charge.
  - Réduire le travail par trame : n'envoyer que les univers routés vers l'USB, tronquer la trame au dernier canal utilisé (DMX permet < 512 canaux, trame plus courte = cadence plus haute et moins de risque).
  - Comparer avec une interface USB Pro (break géré par la puce) pour isoler le problème Open DMX.
- **À faire** : instrumenter (gigue du tick, `maxGapMs`, `breakMs`, `drainMs` déjà exposés par la sortie), reproduire sur la durée (≥ 30 min, avec changements de looks), puis corriger. Ajouter un test de non-régression sur la cadence avec temps injectable.
- **Fait quand** : 1 h de jeu avec changements de scène sans flash visible.

### T2 — Flash en changeant vite de look (transitions)
- **Plan détaillé, revu par 14 modèles : [plan-t2.md](plan-t2.md)** (à lire avant d'implémenter). **Décision de l'utilisateur** : un look relancé en plein fondu repart de son **niveau courant** et reprend sa **position dans l'animation**.
- **Symptôme** : enchaîner rapidement les scènes provoque un flash ; lié aux temps de montée/descente (fondu) des looks.
- **Pistes** : un look qui se relance pendant son fondu repart-il de 0 au lieu de la valeur courante ? Le look sortant et le look entrant s'additionnent-ils (HTP) pendant le croisement ? Exclusivité : le relâchement du précédent et l'attaque du suivant doivent partir de la valeur **courante**, pas de la cible.
- **À faire** : test moteur (temps injectable) : A → B → A en 100 ms avec fondu de 2 s, la sortie ne doit jamais dépasser max(A, B) ni retomber à 0 puis remonter.
- **Fait (2026-11-08)** : la queue d'un look relancé n'est plus jetée — poids de départ `from`, player réutilisé (animation continue), sauf look modifié ou palette changée pendant la queue ; tests d'échantillonnage 20 ms (A → B → A à 25/50/75 %, chaîne A → B → C → A, relance depuis `releasing`, deux relances < 100 ms, partage 1 s / 3 s en fusion « dernier » et « plus fort »). 647 tests verts.

### T3 — Vitesse de montée/descente ignorée pour certains projecteurs (groupe extérieur de l'utilisateur)
- Le fondu d'entrée/sortie n'est pas pris en compte sur eux. Trouver pourquoi (chemin spécifique : canaux bruts ? gradateur générique ? règle ?) et corriger dans la couche moteur commune.
**Précision (2026-11-08)**
- Nouvelle observation de l'utilisateur : le fondu de montée ne s'applique pas à ces projecteurs, **probablement parce que le bouton de fondu agit sur la couleur et non sur le gradateur** (ou l'inverse selon l'appareil).
- Ce que le code montre (`venue/venue.ts` ~l. 495-515 et `show/runtime.ts` `colorsOf`) : le fondu met à l'échelle les **couleurs** peintes par le look ; le **gradateur maître** d'un projecteur à couleurs est tenu à 100 % (seuls les DCA le dosent). Un projecteur dont la couleur ne se met pas à l'échelle (couleur choisie par une **roue**, un canal de **macro/couleur prédéfinie**, un canal **brut** : « pas de fondu, une machine ne se fond pas ») **ne fond donc pas**.
- Correctif : quand la couleur ne peut pas être mise à l'échelle, **le fondu agit sur le gradateur** du projecteur ; jamais sur un canal de mode.
- **Fait (2026-11-08)** : le poids du fondu d'un look accompagne désormais ses **canaux bruts** (`RawWrite { value, weight }`, collecte à la valeur la plus forte — le poids du look gagnant : en fondu-croisé, entrant ou sortant ; montée et descente symétriques, avec l'`entryFade` du look à la montée, qui continue de courir sous le fondu de sortie si le look est arrêté en cours de montée), émission unique dans `venue.toDmx` : un décalage de gradateur est **possédé** par le look (valeur × poids, une seule fois, jamais re-dosé), un décalage de **couleur** suit le poids, un **canal de machine** (roue, macro, effet) tient verbatim et donne son poids à `frame.fade`, qui dose l'octet de gradateur que le show tient à fond — le fondu agit ainsi sur le gradateur des projecteurs dont la lumière ne passe que par une machine ; un projecteur à composantes fonde comme avant (par ses couleurs), une **lampe à roue** fonde par son gradateur (niveau peint) plus le poids machine. Décalages hors définition : verbatim, sans fondu. `stopAll`/Panic coupent tout de suite ; `stop` avec `exitFade` descend tout avec le poids, puis à l'expiration tout retombe (et `frame.fade` ne traîne pas). Spec : [engine-effects-timing](specs/engine-effects-timing.md), section « Fondu des canaux bruts d'un look » ; plan revu en amont par quatre modèles locaux (qwen3.8, qwen3.6, bonsai-2, nemotron-3.5-bolt). 8 tests (`test/plugins/light/show-runtime.test.ts`, T3), 655 verts.
- **Reste, par-delà les tests (critère de déploiement)** : sur la régie, avec **l'utilisateur devant la machine** — sortie en veille vérifiée (`output.status`), puis `dmx.explain` du projecteur extérieur pendant un look en fondu — dire **quelle voie touche son matériel** (canaux bruts, roue, les deux) et dérouler. **Phase 0**, avec T2 et T4 (même couche).

### T4 — Lissage d'un fader DCA : la valeur tombe à moitié au clic
- En activant le lissage sur un fader DCA, il descend de moitié au clic alors qu'il paraît plein ; le clic le **redimensionne** à moitié et la plage de réglage est réduite. À l'arrivée de la valeur sur sa destination (sans glisser), l'interface « plante ».
- **Corrigé (2026-11-08).** Les trois widgets fader partagent `FaderTrack` : rail, curseur, barre de niveau demandé et barre fantôme sont dessinés en DOM, du bas vers le haut, dans une course de hauteur constante. La fantôme s'efface dans la barre permanente à l'arrivée ; le widget ne change pas de taille. Un range transparent garde valeur, focus et sémantique d'assistance ; le composant capture le glisser, mappe les clics sur toute la course, accroche les extrémités et normalise les flèches. Le remplissage inversé du range vertical RTL et ses pseudo-éléments non portables ne participent plus au rendu.
- Le relevé DCA garde **deux lignes de hauteur fixe** : niveau demandé, puis niveau envoyé pendant le glissement ou effectif au repos. L'effectif est relu dès qu'un groupe quitte `light:glide` ; seule la dernière réponse de `group.list` peut réécrire les widgets, pour qu'une réponse en retard ne ramène pas le fader à un état intermédiaire.
- Tests (`test/ui/app.spec.ts`) : les deux régressions « a smoothed DCA fader dragged up and back down keeps its travel and lands on its real level » et « a group list answer that lands late does not rewrite the fader » restent inchangées. « a dashboard fader maps its whole track and keeps keyboard access » vérifie en outre 0/25/50/75/100 %, l'alignement curseur/barre, les clics et les touches. Captures et mesures faites à 1440 × 900 et 480 × 900 dans Chromium et WebKit, avec glissement et arrivée ; glisser tactile vérifié dans Chromium.
- Reste noté (de la relecture par un autre modèle) : le hub WebSocket ne jette pas les trames *control* en retard (`src/core/ws-hub.ts`) ; au-delà du tampon d'envoi (~4 Mio) il déconnecte le client — une télécommande ou une tablette lente sous une rafale de commandes peut perdre la liaison. À ouvrir comme chantier à part si cela se voit en salle.

## 🟠 Lyres : pilotage et réglage

### T5 — Les « modes » des machines hors fondu
- Les canaux de mode (sélecteurs, scènes de couleur, macros) ne doivent **jamais** être fondus ni interpolés. Définir, par projecteur, les pistes **fondables** (intensité, couleur, pan/tilt…) et celles qui ne le sont pas ; ◐ les sélecteurs sont déjà exclus du « poussé à fond ».
- Permettre de **définir les pistes de couleur** d'un projecteur pour corriger un mauvais patch ou une mauvaise définition (override par appareil de la fonction de chaque canal).

### T6 — Changer le mode d'un appareil (mode de fonctionnement du projecteur)
- Dans la gestion de l'appareil : un **menu déroulant** nomme le mode (au lieu d'une valeur brute) et affiche le mode en cours.
- Un mode peut s'étendre sur **plusieurs valeurs DMX** qui en changent légèrement le comportement : le menu choisit le mode, et au besoin la variante.
- Option : **recherche** dans le menu.
- Fader de canal : afficher à gauche la valeur en cours en surbrillance, avec au-dessus et en dessous les plages voisines (avec leurs valeurs d'activation) selon qu'on monte ou descend.

### T7 — Inverser pan et tilt, par lyre
- Case « inverser X » et « inverser Y » sélectionnables par lyre (patch), appliquées avant la sortie, aussi dans l'aperçu de scène et « viser une zone ».
- **Fait (2026-11-09)** : l'inversion existait déjà (`orientation.invertPan` / `invertTilt`, appliquée à la sortie, défaite dans la lecture du faisceau) : seul l'exposé manquait. `venue.fixture.orient` porte les deux booléens, **écrits seulement quand ils sont donnés** (un appel partiel ou un `facing` ne les perd jamais) ; deux cases au menu clic droit de l'appareil (appui long), deux bascules au panneau d'orientation de la lyre sélectionnée, badges X / Y dans la liste du patch ; i18n FR/EN. La **calibration résolue** remplaçait tout l'objet : elle garde désormais `pitch` et `roll`, remet le décalage de pan à 0 (confondu au `yaw`) et re-mesure les inversions. Tests : aller-retours des drapeaux et import ([orientation.test.ts](../test/plugins/light/orientation.test.ts)), DMX réellement inversé au chemin commandes ([moving-heads.test.ts](../test/plugins/light/moving-heads.test.ts)).

### T8 — Calibration manuelle des lyres
- ◐ La calibration guidée existe (à valider sur une vraie lyre). Ajouter la voie **manuelle** : corriger offsets et sens, plages utiles pan/tilt, par saisie et au pad XY, avec la lyre qui bouge en direct ; enregistrer par appareil.

### T9 — Mappage MIDI du pad de contrôle X/Y des lyres
- Faire apprendre/mapper deux CC (ou un couple) sur le pad XY de la lyre sélectionnée ; mode relatif/absolu ; retour MIDI de la position.

### T10 — Manette (gamepad) pour les lyres
- **Placée en phase 6, vers la fin** (décision du 2026-11-07).
- Web Gamepad API, côté navigateur, en trois temps :
  1. 2 lyres via les deux sticks (axes pan/tilt), zoom sur les gâchettes, boutons pour passer d'une lyre à l'autre ;
  2. **scènes de manette** : choisir une disposition (qui pilote quoi) et y mapper boutons/faders selon la scène ;
  3. à décider plus tard (**⚪ pas prioritaire**) : pavé tactile et gyroscope de la manette PS5 (lyre supplémentaire, contrôle au gyro) ; à rediscuter avant tout développement, et seulement si le navigateur expose proprement la manette PS5.

## 🟠 Patch et lieu

### T11 — Menu d'un appareil (clic droit) : gestion complète
- ◐ Le clic droit renomme et colore déjà. Ajouter : **déplacer dans le patch** (adresse/univers), **changer le mode** (T6), supprimer.
- ◐ Les chevauchements d'adresses sont déjà signalés au patch et dans « Vérifier le show » : afficher aussi un **avertissement visible sur les deux appareils** dès qu'ils se recouvrent, dans le menu et la liste du patch.

### T12 — Choix du type de projecteur : canaux disponibles
- À la sélection d'un type, n'afficher que les **modes et canaux de ce type** (pas tous les canaux de toutes les définitions).

### T13 — Gestion des canevas
- Éditer un canevas existant, y ajouter ou en retirer des éléments, plus facilement (sélection multiple, glisser, suppression directe, annuler/rétablir).

## 🟠 Looks, intentions, instantanés

### T14 — Créer un look par intention : thématiques
- Dans la création par intention, **rechercher et sélectionner une ou plusieurs thématiques** (combobox à choix multiples ou liste).

### T15 — Gérer les intentions
- Ajout, suppression et édition des intentions depuis l'interface ; **export dans les `.lightshow`** (comme les définitions de projecteurs depuis d2f7844) ; vérifier l'import et l'archive aller-retour.

### T16 — Instantané choisi au redémarrage
- Pouvoir désigner l'instantané rappelé automatiquement au démarrage de l'application (réglage du show ; interaction à définir avec la reprise après plantage de moins de 5 min et avec la sortie en veille).

### T17 — Dossiers de looks
- Changer le dossier d'un look (éditeur et clic droit).
- **Vue par dossier** de la page Show : dossiers dépliés par défaut.
- **Fait (2026-11-09)** : le dossier reste le **tag conventionnel `dossier:`** posé par l'import QLC+ — pas de champ dédié dans le modèle, aucune commande ni migration (anciens shows, imports et archives `.lightshow` fonctionnent tels quels) ; l'écriture passe par `look.put`, déjà tout-puissant. Helpers purs dans [folder.ts](../web/src/folder.ts) : le dossier d'un look est son **premier** tag `dossier:` nommé (un tag vide ou doublé ne compte pas, et un premier passage éditeur/menu le nettoie). **Éditeur** : champ « Dossier » (`<input>` + `<datalist>` des dossiers connus) dans le haut des champs ; le champ tags ne porte plus le dossier (un `dossier:` tapé là est éliminé au flou, le champ dédié l'emporte). **Clic droit** : un `<select>` des dossiers existants + « Sans dossier », qui relit le look entier avant `look.put` (le look abrégé serait refusé). **Liste du show** : dès qu'un dossier existe, une seule table groupée — en-têtes repliables dépliés par défaut, « Sans dossier » en dernier, groupes vides masqués (recherche ou filtre), le filtre déroulant suit le rangement réel (`folderOf`, pas une sous-chaîne de tag, pour un look au double dossier). La liste des dossiers est passée à l'éditeur par ses deux hôtes (page Show et Live). Tests : [app.spec.ts](../test/ui/app.spec.ts), 4 nouveaux sur le semis du filtre (groupes et repliage, menu, éditeur, tags vides et doublons).

### T33 — Gérer les dossiers : créer, renommer, dissoudre, déplacer plusieurs looks (demandé le 2026-11-09)
- **Fait (2026-11-09)**, suite du T17 : tout passe par **trois commandes serveur** — `show.folder.move {ids, folder?}` (les looks sont lus **entiers côté serveur**, un id inconnu refuse tout avant d'écrire), `show.folder.rename {from, to}` (le tag réécrit sur chaque look du dossier ; renommer sur un nom existant **fusionne** les deux), `show.folder.delete {folder}` (dissout : les looks repassent « sans dossier » ; les looks restent, rien à supprimer — un dossier n'est qu'une convention de tag) — suivies par MCP, HTTP, OSC et CLI gratuitement ; réécriture par `look.put`, donc history et « Annuler » par look. **Interface** : « ➕ **Nouveau dossier…** » au menu d'un look (crée le dossier et y range le look) ; un menu au **clic droit de l'en-tête** d'un dossier (appui long tablette) : Renommer, Dissoudre (confirmé) ; **multi-sélection** des lignes (⌘/Ctrl : une de plus ou une de moins, Maj : de l'ancre à celle-ci, Échap désélectionne, la sélection suit les suppressions) par le `pick` des dashboards ([selection.ts](../web/src/selection.ts), déjà testé) ; **glisser-déposer** (souris ou plume) des lignes choisies sur un en-tête = un `show.folder.move` (seuil 8 px, l'en-tête visé s'entoure d'accent, déposer dans son propre dossier ne réécrit rien ; le toucher garde son défilement et ses menus). Déposer les derniers looks d'un dossier, ou dissoudre le dernier : la table **redevient plate**. Helpers purs du serveur dans [folders.ts](../src/plugins/light/show/folders.ts), qui portent aussi les tags de l'import QLC+. Tests : les 3 commandes ([folders.test.ts](../test/plugins/light/folders.test.ts)), 3 parcours UI dans [app.spec.ts](../test/ui/app.spec.ts) (multi-sélection + drague, création au menu, en-tête renommé et dissous).
- **Repris le 2026-11-10** après l'essai (retours de l'utilisateur) : un bouton **« 📁 Nouveau dossier… »** au-dessus de la liste (à côté de « + Nouveau look ») qui nomme le dossier et **y passe la sélection** ; à la demande du même essai, **les dossiers vides existent** : le show tient une liste `folders` (dans show.json, comme `absentFixtures` — sans migration, les archives la portent) que `show.folder.create` nourrit, `show.folder.rename` suit et `show.folder.delete` vide — un dossier nommé **naît vide et se voit** (« ▾ (0) » tant que la liste repose, masqué par une recherche ou le filtre), un dossier né d'un tag reste du côté des tags ; **Ctrl+clic sur macOS sélectionne** au lieu d'ouvrir le menu (le navigateur le donnait pour un clic droit — c'est lui qui bloquait la sélection) ; la sélection de lignes **se voit** (teinte accent, rail sur la première cellule) ; la rangée « Nouveau dossier » du **menu remise sur une seule ligne** (l'input pleine largeur chassait son ✔ à la ligne) ; la **sélection de texte** du navigateur coupée sur la liste groupée (`user-select: none`), qui prenait le pointeur en pleine drague.
- **Toujours le 2026-11-10, sur demande** : **les sous-dossiers** par chemin (« Famille/Sous-dossier »), créés depuis le menu d'un en-tête (« ➕ Sous-dossier », le nom du parent prêt) ou tapés avec un `/` dans le champ dossier ; `show.folder.nest` (réalisé par le renommage, qui garde la queue des chemins descendants et suit la liste des dossiers nommés) place un dossier sous un autre ou le remonte, par le **glisser d'un en-tête sur un autre** comme pour un look ; l'en-tête de chaque niveau est indenté avec un connecteur « └ », son compté inclut sa branche, **plier un parent replie toute sa branche**, le filtre suit l'arbre ; et la drague gagne un **fantôme** (nom du look, ou du dossier, compté quand ils sont plusieurs) qui suit le pointeur, avec curseur de poignée sur la liste et enfoncement animé de l'en-tête visé. **Déposer sur une ligne de look file dans le dossier de ce look** (un dossier déposé sur une ligne se niche dans son dossier ; la ligne visée s'entoure d'accent comme un en-tête). **Ce que le dossier tient se voit sans étiquette** (le chemin répété ligne à ligne a été retiré à l'essai) : teinte d'accent très légère derrière les lignes membres, et la branche d'un look niché file à travers leurs rails, sa propre jambe en accent.

### T34 — Doublon de définition : « Remplacer » à l'import (signalé et fait le 2026-11-10)
- **Symptôme** : ajouter un `.qxf` dont le nom existe déjà avec un autre contenu est refusé, mais la page Import n'offrait aucun bouton pour remplacer (le texte du refus disait « replace pour le remplacer » sans rien de cliquable) et n'envoyait jamais `replace`.
- **Fait (2026-11-10)** : le refus de `fixture.definition.add` est une `CommandError` portant `detail { exists, file }` (relayé jusqu'à l'interface par `ApiError.detail`) ; la page Import garde le fichier refusé et affiche **« Remplacer »**, après une confirmation qui nomme le fichier écrasé. Tests : commande (détail, contenu identique accepté, `replace: true` écrase ou crée), parcours UI refus → Remplacer → ✔ (le 422 attendu est filtré). Plan relu en amont par deux modèles locaux (qwen3.8, bonsai-2) ; le code a été écrit par Claude (flint, délégué d'abord, a dépassé le délai sans rien écrire). La question « définition ou appareil du patch » est tranchée : **définition** ; rien n'a été trouvé pour le doublon d'un appareil (`venue.fixture.put` est un upsert, voir T22).
- **Reste** : la détection porte sur le **nom de fichier** seulement : un même modèle sous un autre nom entre sans avertissement (T20).

### T35 — Les boutons de look doivent tenir compte des DCA en place sur leurs pistes (demandé le 2026-11-10)
- **Besoin** : quand un look est lancé par un bouton, il doit **prendre en compte les DCA déjà en place** sur la piste (le projecteur ou le canal) qu'il touche : le niveau final suit le dosage du DCA, au lieu de l'ignorer.
- **À faire** : vérifier ce que fait le moteur aujourd'hui (un DCA dose-t-il les looks qui peignent ses projecteurs, ou seulement ses propres faders ? cf. `dmx.explain`, « Entre les boutons », T3 sur le gradateur) ; fixer la règle dans la couche moteur commune, pas dans l'interface ; test moteur (temps injectable) : look lancé sous un DCA à 50 % → sortie à 50 %, DCA relevé → suit.
- **À préciser avec l'utilisateur** : « piste » = projecteur, canal brut ou groupe ? et le cas d'un look qui lance un fader de canaux dosé par un DCA (déjà prévu) vs un look ordinaire.

### T36 — Les looks permettent-ils de régler autre chose que la couleur ? (à vérifier, demandé le 2026-11-10)
- **À vérifier par l'utilisateur** : un look peut-il modifier **d'autres réglages des appareils hors couleurs** (gobo, prisme, focus, zoom, frost, macros, vitesses, canaux de mode…) ? Dire ce qui manque dans l'éditeur de look.
- **Piste** : si ce n'est pas assez accessible, l'offrir au besoin dans un **mode avancé** de l'éditeur (replié par défaut), au lieu de l'afficher à tout le monde. Existant à regarder avant d'écrire : les **canaux bruts** d'un look (boutons machine) et leurs fonctions par nom, T5 (pistes fondables, canaux de mode jamais fondus) et T6 (modes nommés).
- **Fait quand** : la liste des réglages hors couleur modifiables par un look est connue, et ce qui manque est ouvert en tâche.

## 🟠 Définitions de projecteurs (analyse du 2026-11-07 : Wash 1915Z-R, Spot 200, Fog Spray 3000 RGB)

Constats, relevés dans le code ([venue.ts](../src/plugins/light/venue/venue.ts), [qxf-import.ts](../src/plugins/light/venue/qxf-import.ts)) et dans les `.qxf` de `data/fixtures/` (privé, rien de tout ça ne va dans le dépôt) :
- **Doublons silencieux.** Le Wash existe en deux fichiers identiques à l'octet près, le Spot en deux versions différentes (l'une « générée d'après le manuel » par un agent, l'autre importée du manuel). `findDefinition` compare les noms sans casse ni ponctuation puis prend le **premier** trouvé : la définition utilisée dépend de l'ordre de lecture du dossier, sans avertissement.
- **Wash : seule la zone 1 est pilotée.** Le `.qxf` n'a aucun `<Head>` ; sans tête déclarée, le moteur prend la **première** occurrence de chaque composante (Rouge 1, Vert 1…). En mode 29 canaux, les zones 2 et 3 et le halo RGB ne reçoivent jamais la couleur peinte.
- **Wash : canaux sans plages nommées.** Macro, CTO, effet du halo et leurs vitesses sont une capacité unique 0-255 : pas de menu de mode possible (T6), pas de repère sur le fader. Ces définitions viennent d'un manuel, pas de la machine : à vérifier sur la lyre.
- **Spot : bonne base pour les couleurs.** La roue a 10 couleurs pleines (avec leur `#rrggbb`), 10 doubles couleurs et une rotation.
- **Fog Spray 3000 RGB : classé machine** (type Smoke, canal « Smoke Release »), donc jamais poussé à fond. En revanche « Color Fade Mode » et « Color Change Mode » sont des canaux de **mode** (6-255 = actif) : ils ne doivent pas être fondus (T5) et rien ne les empêche d'être activés ensemble ou avec les canaux RGB. Le patch lui-même est sain (adresse 60, 7 canaux, aucun chevauchement).
- **Patch du show de test** : seul le Spot a une position et une orientation ; le Wash et le Fog n'en ont pas, donc ni faisceau juste ni aperçu fiable.

### T18 — Roue de couleurs : association automatique à la plus proche
- ◐ Existe déjà : `nearestSlot` choisit la case de la roue la plus proche d'une couleur peinte (distance sur la chromaticité, l'intensité va au gradateur).
- **À améliorer** :
  - **Ignorer les doubles couleurs** (`ColorDoubleMacro`) : seule la première moitié est lue aujourd'hui, ce qui fausse le choix (« Rouge + Vert » compte comme un rouge). Soit les exclure, soit les mélanger ; proposer aussi « autoriser les doubles » en option.
  - **Distance perceptuelle** (OKLab/Lab) à la place de la distance RGB normalisée : roses, oranges et blancs chauds se départagent mieux.
  - **Blanc** : si la couleur est presque neutre, choisir la case blanche (ou « Open ») plutôt qu'une teinte pâle ; si la lyre a un CTO ou un blanc chaud, le citer.
  - **Valeur au milieu de la case** (pas au bord `min`) pour tenir malgré la dérive du DMX.
  - **Hystérésis** : un dégradé de couleur ne doit pas faire sauter la roue d'une case à l'autre à chaque tick (une roue qui tourne produit des flashs de couleurs intermédiaires) ; ne changer de case que si la nouvelle est nettement plus proche, et jamais en plein fondu.
  - **Aperçu** : la scène en direct montre la couleur **réelle** de la case, pas celle demandée ; afficher l'écart.
  - **Correspondance modifiable** par appareil (couleur → case) pour corriger une définition fausse ; un test avec les 10 couleurs du Spot.

### T19 — Images pour les gobos (et les cases de la roue)
- Aujourd'hui les gobos ne sont que des noms (« Gobo 1… ») ; QLC+ sait y associer une image, on ne la lit pas.
- **Proposition** : lire l'image d'une capacité quand la définition en a une ; sinon une **bibliothèque d'images** par type de projecteur (`data/gobos/`, privée) associée par fichier annexe (`<définition>.gobos.json` : case → image ou nom), plus un petit jeu de formes génériques libres de droit livré dans le dépôt (point, étoile, rayons, cercles…).
- **Où** : sélecteur de gobo (miniatures dans la liste de plages du fader, T6), éditeur de look, aperçu de la scène (le faisceau prend la forme du gobo, en option), export `.lightshow` (images embarquées comme les définitions, d2f7844).
- À trancher : format des images (PNG/SVG, taille max), et où se téléverse l'image (page Bibliothèque, T20).

### T20 — Bibliothèque des projecteurs : gestion complète
- **Découpée** : **T20a** (phase 2) = détection des doublons et avertissement dans « Vérifier le show » ; **T20b** (phase 4) = tout le reste (page, fusion, duplication, éditeur, suppression).
- **Nouvelle page « Bibliothèque »** (ou section de la page Lieu) listant les 600+ définitions : recherche, fabricant, type, nombre de modes, **projecteurs patchés qui l'utilisent** (via `show.references`).
- **Détecter les doublons** : même fabricant+modèle après normalisation, ou même signature (canaux, plages, modes) sous deux noms ; montrer la différence champ par champ avant de décider.
- **Fusionner** : garder une définition, rediriger l'autre vers elle (alias) pour que les appareils déjà patchés suivent sans changer d'adresse ni de mode ; refuser si un mode utilisé disparaît, ou proposer la correspondance de modes.
- **Dupliquer / éditer** : copie privée modifiable (renommer, ajuster canaux, plages, têtes, images) sans toucher à l'original ; un éditeur de définition **dans l'interface** (canaux, capacités, modes, `<Head>`) au lieu d'éditer le XML.
- **Supprimer** : refusé tant qu'un appareil s'en sert (sauf `force`), corbeille récupérable, comme les looks.
- **Avertir** quand deux définitions portent le même nom et que la première gagne aujourd'hui sans le dire (ajouter à « Vérifier le show »).
- Les commandes sortent d'abord comme **commandes** (outil MCP, route HTTP, CLI), l'interface n'étant qu'un adaptateur, conformément aux règles du dépôt.

### T21 — Têtes et zones : piloter toutes les zones d'un projecteur
- Quand une définition n'a pas de `<Head>` mais répète des composantes (Rouge 1/2/3…), **déduire les têtes** par numéro de suffixe, ou laisser l'utilisateur les déclarer dans l'éditeur (T20), et signaler « Vérifier le show » quand un projecteur ne reçoit la couleur que sur une zone.
- Wash : zones 1 à 3 + halo (le halo peut rester en canaux bruts ou suivre la couleur, au choix).

### T22 — Propositions de contrôle automatique du patch
Ajouts à « Vérifier le show » et à `venue.patch.check` :
- projecteur **sans position ni orientation** (faisceau et aperçu faux) ;
- canal de **mode** laissé hors du repos (fumée, effet de halo) ou deux modes exclusifs actifs ensemble ;
- **mode DMX du patch ≠ mode physique** : demander de confirmer le mode, avec le nombre de canaux et l'adresse suivante libre ;
- adresse de fin > 512, trou inutile entre deux appareils, deux appareils identiques sans nom distinct ;
- proposition de **groupes automatiques** (par type : lyres, machines, wash) et de tags à la création du patch ;
- **canal Reset** (Spot, Wash) : ne jamais le laisser s'activer par un fader, un look ou une règle ; dans les règles par défaut.

## 🟠 Mouvements des lyres (demandes du 2026-11-08)

Note : la **priorité entre couches de mouvement** (T25) et le **sous-look partagé par deux looks** (T29) sont **volontairement reportées** : à trancher avec l'utilisateur quand ces tâches seront attaquées.

### T23 — Positionnement relatif des lyres par visées communes (triangulation)
- **Besoin** : placer les lyres les unes par rapport aux autres sans mesurer la salle : on pilote les lyres **une à une** pour les faire pointer **sur un même point**, à **plusieurs reprises** (plusieurs points communs), et le logiciel **triangule** leurs positions.
- **Existant** (`src/plugins/light/commands/move-commands.ts`, `calibration.record` / `calibration.solve`, `venue/aim.ts`) : la calibration guidée sert **une tête à la fois**, repères **connus**, position de lyre **connue** ; elle trouve l'orientation (yaw, décalage de tilt, inversions). T23 est le problème inverse : repères **inconnus**, positions de lyres **inconnues**.
- **Principe** : chaque visée donne, pour une lyre, un rayon (pan/tilt → direction dans son repère, avec inversions et plages 540°/270°). Chaque point commun est l'intersection des rayons des lyres qui l'ont visé. Résolution par moindres carrés (ajustement de faisceaux) : position (x, y, z), yaw et décalage de tilt de chaque lyre, plus les points communs.
- **Ambiguïtés** : fixer la **jauge** (une lyre à l'origine, un axe, **une distance connue** ou une hauteur pour l'échelle) ; au moins 2 lyres et ~4 points non coplanaires pour la hauteur ; en dessous, dire ce qui manque.
- **Découpage** : (1) module pur de résolution + tests sur visées simulées avec bruit ; (2) commandes `calibration.shared.record` / `.solve` / `.clear` (MCP, HTTP, CLI) ; (3) assistant dans la page Lieu : choisir les lyres, viser le point commun lyre par lyre au pad XY, valider, répéter, erreur par visée et par lyre, appliquer au patch avec annulation.
- **Rang** : parmi les plus durs ; **phase 4**, après T8 (partage le pad et la page). **Prérequis** : T7, T8, pad XY par lyre. **Alimente T24** (une cible 3D n'a de sens que si les positions des lyres sont connues).

### T24 — Point cible 3D piloté (X, Y, Z) que les lyres suivent
- **Besoin** : un **point à cibler** dans la scène, contrôlé en **X + Y** (pad) et **Z** (fader à côté du pad) ; les lyres choisies le suivent.
- **Existant** : `position.aim` sait viser une zone ou un point `{x, y, z}` en mètres, une fois, en posant une position manuelle ; il lui manque un **objet « cible » vivant** que l'on déplace en continu.
- **Proposition** : un objet **Cible** (id, nom, X, Y, Z, lyres liées, lissage) ; la cible bouge → recalcul de pan/tilt de chaque lyre liée par `venue/aim.ts`, **dans le moteur** (pas côté navigateur) pour que MIDI, OSC, manette (T10), MCP et IA la pilotent aussi. Widget de dashboard « Cible » : pad XY sur le plan de la scène + fader Z ; apprentissage MIDI de X, Y, Z (T9).
- **Limites** : lyre hors de portée ou visée vers une zone interdite aux lyres : signalé, la lyre garde sa dernière position permise (règles de zones déjà en place). Z borné au volume de la scène.
- **Prérequis** : positions et orientations des lyres exactes (saisies ou T23), T7. **Rang** : moyen-dur ; **phase 3-4**.

### T25 — Revoir toute la gestion des mouvements via les looks
- **Constat** (`show/runtime.ts`, `engine/move.ts`, `show/model.ts`) : un look porte un `move` (forme autour d'un centre en pan/tilt **normalisés**, par lyre) ; une **position manuelle** (`manualPositions`, pad XY) l'emporte sur tous les looks jusqu'à relâchement ; viser une zone ou un point pose aussi une position manuelle. Il n'y a ni couche de priorité claire, ni « mouvement » réutilisable, ni cible vivante.
- **À concevoir avec l'utilisateur** (priorité des couches : décision reportée à l'attaque de T25 ; pas de code avant décision, et décision à noter dans `decisions.md` et `specs/engine-effects-timing.md`) :
  - une **couche Mouvement** séparée de la couleur, avec une priorité explicite et visible : *position manuelle* > *cible* (T24) > *mouvement du look* > *centre* ;
  - des **positions nommées** (presets de position, en pan/tilt ou en point 3D) qu'un look **référence** plutôt que de copier ;
  - un look peut **ne pas toucher au mouvement** (couleur seule) sans relâcher le mouvement courant ;
  - le comportement au **changement de look** : le mouvement fait un fondu de position (T2 couvre l'intensité, pas la position) ;
  - l'éditeur de looks : section « Mouvement » claire (mode : aucun / forme / position nommée / cible).
- **Rang** : dur (touche modèle, moteur, éditeur, migration des looks existants). **Phase 3**, **avant T24**, car T24 et T26 s'y appuient.

### T26 — Autoriser / bloquer la gestion des mouvements
- **Besoin** : pouvoir dire quand les lyres ont le droit de bouger.
- **Proposition, par niveaux** :
  - **Verrou global « Figer les lyres »** (bouton visible sur toutes les pages, mappable en MIDI/OSC), **à deux niveaux choisis par l'utilisateur** : **souple** = les looks et la cible ne bougent plus les lyres, le pad XY à la main reste libre ; **dur** = rien ne bouge, pad compris. Dans les deux cas la position courante est gardée ; relâcher le verrou reprend en douceur (vitesse limitée par les règles) ;
  - **par lyre ou par groupe** (menu clic droit d'un appareil, T11) : « mouvement autorisé / bloqué » ;
  - **par look** : « ne pas bouger les lyres » (couleur seulement), en lien avec T25 ;
  - **par rôle** (droit `commands:position` existant) : qui peut déplacer ; une règle verrouillée tient malgré les forçages de la console DMX.
- **À préciser** : le Blackout garde déjà la position ; **Panic** ne doit pas faire bouger les lyres ; la sécurité des zones interdites s'applique toujours. À sauvegarder dans l'instantané (T16).
- **Rang** : facile à moyen pour le verrou global et par lyre ; le reste suit T25. **Phase 3**, le verrou global dès que T25 est décidé.

### T27 — Zones de visée dessinées (batterie, piano, choristes, public…), visibles sur le pad XY
- **Besoin** : dessiner des **zones nommées** sur la scène, que les lyres peuvent viser, et les **voir sur le pad XY**.
- **Existant** : la page Lieu crée déjà des **zones** (rectangles, zones protégées, zones interdites aux lyres) et `position.aim` sait viser le centre d'une zone (à 1,5 m par défaut). Il manque : des zones **de visée** (pas seulement de protection) à forme libre (rectangle, ellipse, polygone), une hauteur de visée par zone, et leur affichage sur le **pad XY** (T9/T24) avec un clic ou un glisser pour y envoyer les lyres.
- **À faire** : type de zone « visée » (nom, forme, hauteur, couleur) ; commandes `stage.zone.*` étendues (déjà en place pour les rectangles) ; dessin au doigt/souris sur le plan ; pad XY qui affiche les zones (étiquettes lisibles, jamais l'une sur l'autre comme le plan) ; export `.lightshow` avec le lieu.
- **Rang** : moyen. **Phase 3**, après T24 pour le pad ; les zones existent dès maintenant dans le plan.

### T28 — Looks de lyres par zone : clic par zone, motif de déplacement ou déplacement aléatoire
- **Besoin** : sur un look de lyres, **un bouton par zone** (les lyres vont sur la zone), puis soit **suivre un motif de déplacement** (parcours entre zones/points), soit **se déplacer au hasard entre les points** choisis.
- **Faisable ?** Oui, c'est cohérent avec l'existant : les Move FX (formes, `engine/move.ts`) et la visée par zone (`position.aim`). Il faut une **liste de points/zones** dans le mouvement d'un look, un **ordre** (boucle, aller-retour, aléatoire pondéré comme les pas de couleur), une **vitesse** (cadence ou BPM) et un **temps de déplacement** respectant la vitesse max pan/tilt des règles.
- **Dépend de** : T27 (zones), T25 (couche Mouvement). **Rang** : dur ; **phase 4**.

### T29 — Mouvements indépendants des pas du look, et sous-looks
- **Besoin** : les lyres doivent pouvoir avoir **d'autres déplacements que les pas du look**, soit par un **look spécial de mouvement**, soit surtout en faisant qu'**un look en lance un autre** : le **sous-look** (« super feature » selon l'utilisateur).
- **Modèle proposé** : un look peut référencer des **sous-looks** (liste, avec leurs cibles : lyres ou groupes). Le sous-look a sa **propre horloge** (cadence, BPM, pas) indépendante de celle du parent. Sous-look de mouvement d'abord ; rien n'empêche un sous-look de couleur ensuite.
- **Deux modes de relance** (au choix du parent, par sous-look) : **continuer l'animation où elle en était** (le sous-look garde son compteur de pas, comme la décision T2 pour les relances en fondu) ou **reprendre depuis le début**.
- **Cas à trancher à l'attaque** : **deux looks différents ayant le même sous-look**. Ma proposition de départ : **une seule instance** du sous-look, comptée par référence (lancée par le premier parent, arrêtée quand le dernier parent s'arrête), avec la priorité de la couche Mouvement (T25) ; alternative : une instance par parent. À décider avec l'utilisateur, comme la priorité des couches.
- **Points d'attention** : boucles interdites (A lance B lance A), profondeur limitée, `show.references` doit connaître le lien (suppression refusée tant qu'un parent s'en sert), archives `.lightshow`, exclusivité des groupes (le sous-look n'est pas un bouton de plus), « Vérifier le show » (sous-look manquant).
- **Dépend de** : T25. **Rang** : très dur (modèle, moteur, éditeur, migration). **Phase 3**, avec T25.

### T30 — Placer et régler les lyres avec des angles seulement (sans mesurer les distances)
- **Besoin** : en prestation, on ne peut pas toujours mesurer des distances. Placer et configurer les lyres **à partir d'angles** seulement.
- **Idée** : combiner l'existant et T23 : la lyre est posée **à la main sur le plan** (position approximative, à l'œil), puis on **vise des repères visibles** (zones dessinées en T27, scène, rampes) au pad XY ; le logiciel déduit yaw, montage et décalage de tilt (calibration guidée actuelle, sans aucune distance), puis **affine les positions relatives par triangulation** (T23). L'échelle absolue se fixe avec **une seule estimation** (hauteur d'accroche, ou largeur de scène) ou reste en unités relatives, avec l'incertitude affichée.
- **À signaler** : « position approximative » (± en mètres), conséquences sur la précision de la visée par zone.
- **Dépend de** : T23, T27. **Rang** : dur ; **phase 4**, après T23.

### T31 — Contrôler une lyre depuis sa sélection (demandé le 2026-11-09)
- **Besoin** : quand on **sélectionne une lyre** sur le plan, pouvoir la **contrôler en complet** — la déplacer (pan/tilt) et gérer sa lumière — depuis la sélection, comme une console qui ouvre la fiche de l'appareil choisi.
- **Fait (2026-11-09)** : sur le plan du lieu, **un clic sur un projecteur le sélectionne sans aucun mode** (la sélection ne tenait que pendant « Orienter ») ; elle reste en sortie de mode, se rend par ✕ (ou Échap pendant « Orienter ») et ouvre son **panneau de contrôle** (web/src/components/FixturePanel.tsx) sous le plan. **Mouvement** (lyre seulement, droit `commands:position`) : le pad XY de cette lyre seule (`position.set {fixtures:[id]}`), position en %, « ⟲ » rend les looks ; la **sélection tenue affine « Viser »** : le point visé tourne cette lyre seule (`position.aim {point, fixtures:[id]}`), sans sélection toutes les lyres (comme avant). **Lumière** (droits `show:write` et `commands:level`, sinon une ligne le dit) : les canaux non pan/tilt en **faders de canaux** — au **premier toucher** d'un canal, `fader.put` crée un fader strictement mono-canal (id déterministe `panel-{lyre}-{décalage}`, nom préfixé « Panneau · {lyre} · {canal} »), démarré au niveau que le canal a **maintenant** (le défaut 0 ne doit pas éteindre un gradateur allumé), **sans `dca`** (un fader dosé deux fois le serait double) ; ensuite `fader.level` suit le glissement ; un fader existant n'est réutilisé que s'il est déjà strictement mono-canal du même canal ; les faders créés sont dosés par les DCA comme les autres. Le **retour d'état du pad** se resynchronise sur les commandes `position.*`, `panic` et l'ouverture d'un show (sinon le point reste faux après une visée, une libération ou une Panic venue d'ailleurs).
- **Noté** : les positions manuelles sont **en mémoire** (perdues à une Panic, une libération, la réouverture d'un show) — documenté ; le pad du panneau garde `touch-action: none` (comme le widget), le plan ne réagit pas au même point. La **3D** ne fait pas partie de v1 (aucune sélection d'aujourd'hui).
- **Retours du jour (2026-11-09)** : dans le menu de l'appareil, les inversions se rendent comme les bascules de l'interface (« libellé à gauche, bascule à droite », motif `ghost` pressé) — une case cochée native y restait sur sa propre ligne et ne répondait pas ; elles **ne se rendent que sur un projecteur qui porte pan ou tilt** (`venue.fixture.list` ajoute `movable`) ; et le **calibrage suit la sélection** (la lyre tenue sur le plan ouvre « Calibrer les lyres » sur elle).
- **Rang** : fait (facile : le pad XY et les faders existaient, il ne restait qu'à les composer derrière une sélection).

### T32 — Positions nommées des lyres (presets de position), réutilisables dans les looks (demandé le 2026-11-09)
- **Besoin** : enregistrer des **positions nommées** pour les lyres : la position se pose au **pad XY** de la lyre sélectionnée (T31) ou en visant une zone, puis s'**enregistre sous un nom** ; une **liste** les retrouve, on les **rappelle** (les lyres s'y rendent), et un **look peut y faire référence** au lieu de copier des pan/tilt — le look suit si la position est réajustée.
- **Existant** : `position.set` / `position.aim` (commands/move-commands.ts) posent une position **manuelle en mémoire seule** (perdue à une Panic, une libération, la réouverture d'un show, cf. T31) ; le pad XY de la T31 pose des positions mais n'en garde rien ; les **faders de canaux** (`fader.put`) montrent le chemin du réglage persistant par objet (un JSON par objet, id déterministe) ; le `move` d'un look est une **forme** autour d'un centre normalisé ([engine/move.ts](../src/plugins/light/engine/move.ts)), sans référence à rien. **Aucune position n'est persistée** aujourd'hui, aucun look n'en cite une.
- **Modèle proposé** : un objet **Position** (id, nom, contenu : pan/tilt par lyre couverte, ou point `{x, y, z}` si les positions des lyres le permettent — cf. T24), stocké comme les faders ; commandes `position.preset.list / save / go / delete` (MCP, HTTP, OSC et CLI en adaptateurs minces ; la **suppression refusée** tant qu'un look s'en sert — `show.references`, comme pour les autres liens) ; export `.lightshow` avec le show ; bouton « Enregistrer cette position… » au **panneau de la lyre sélectionnée** (T31) ; dans l'éditeur de look, la section Mouvement peut **référencer** une position nommée (la priorité « manuelle > cible > look » du T25 décidera du conflit au rappel).
- **À trancher à l'attaque** (décisions à noter dans `decisions.md` + la spec) : une position porte **une lyre, un groupe ou toutes** ; ce que fait le rappel pendant qu'un look tourne ; les **plages pan/tilt** différentes (une position ne s'applique qu'aux lyres qui la couvrent) ; une position **périmée** après un déplacement ou une recalibration de lyre (T8).
- **Interface** : partout où l'on choisit une position nommée — l'**éditeur de look** (référence du mouvement), le **panneau de la lyre sélectionnée** (rappel rapide) et le **Live** — le choix se fait dans une **liste déroulante avec recherche**, pas un `<select>` qui déborde dès qu'il y a beaucoup de positions. L'application n'a pas de combobox aujourd'hui : à créer à cette occasion (ou `<datalist>` natif, cf. le champ dossier du T17).
- **Rang** : moyen-dur. **Phase 3-4** — l'enregistrement et le rappel d'une position (une lyre seule) est de la phase 3 ; la **référence dans les touches au modèle des looks** (T25 conçoit la couche Mouvement). S'articule avec T24 (la **cible** 3D est pilotée en continu, la position nommée est **statique** — complémentaires), T8, T27 et T28.

## Du plus simple au plus dur (estimation du 2026-11-08)
| # | Item | Pourquoi |
|---|---|---|
| 1 | T7 inverser pan/tilt | l'orientation sait déjà inverser (`invertPan`, `invertTilt`) : à exposer dans le patch |
| 2 | T17 dossiers de looks | changement d'un champ + une vue groupée |
| 3 | T16 instantané au démarrage | un réglage du show + un rappel au boot |
| 4 | T12 canaux du type choisi | filtre d'affichage dans le sélecteur |
| 5 | T14 thématiques en combobox | composant d'interface, données déjà là |
| 6 | T4 fader DCA et lissage | bug d'affichage à reproduire, correctif probablement local |
| 7 | T22 contrôles du patch | beaucoup de petites règles, chacune simple |
| 8 | T11 menu clic droit complet | renommer et colorer existent ; reste déplacer, mode, suppression |
| 9 | T26 verrou « Figer les lyres » (global, par lyre) | un drapeau dans le moteur et un bouton ; le par-look suit T25 |
| 10 | T18 roue de couleurs | module pur, testable sans matériel |
| 11 | T3 fondu ignoré sur certains projecteurs (groupe extérieur) | cause à confirmer avec `dmx.explain` ; fondu à étendre au gradateur |
| 12 | T21 têtes et zones | déduction par suffixe + test sur le Wash |
| 13 | T15 gestion des intentions + export | CRUD complet et archive aller-retour |
| 14 | T9 pad XY en MIDI | apprentissage de deux CC, retour de position |
| 15 | T5 pistes fondables / pistes de couleur | touche au moteur et au modèle de définition |
| 16 | T2 flash en changeant vite de look | logique de croisement du moteur, plan prêt et revu ([plan-t2.md](plan-t2.md)) |
| 17 | T13 édition des canevas | éditeur graphique (sélection, glisser, annuler) |
| 18 | T6 modes en menu + valeurs voisines sur le fader | nouveau widget, plages à nommer pour chaque définition |
| 19 | T27 zones de visée dessinées et affichées sur le pad XY | types de zones, dessin, pad ; les zones rectangulaires existent déjà |
| 20 | T8 calibration manuelle | interaction temps réel avec une vraie lyre |
| 21 | T19 images de gobos | format, bibliothèque, aperçu, export |
| 22 | T24 point cible 3D (X, Y, Z) suivi par un groupe de lyres | objet vivant dans le moteur, widget pad + fader Z |
| 23 | T32 positions nommées des lyres (presets) | enregistrer au pad et rappeler ; la référence dans les looks suit T25 |
| 24 | T28 looks de lyres par zone, motifs et aléatoire | liste de points dans le mouvement, ordres, vitesse limitée |
| 25 | T30 placer les lyres avec des angles seulement | interface au-dessus de T23, incertitude à afficher |
| 26 | T20 bibliothèque des projecteurs | page entière : doublons, fusion par alias, éditeur de définition |
| 27 | T23 triangulation des lyres par visées communes | maths de résolution + interaction temps réel avec de vraies lyres |
| 28 | T25 revoir les mouvements via les looks | modèle, moteur, éditeur, migration ; décision de priorité à prendre |
| 29 | T29 sous-looks et mouvements indépendants des pas | très dur : modèle, moteur, éditeur, références, migration |
| 30 | T10 manette | trois étapes, API navigateur, scènes de manette |
| 31 | T1 flashs sur le DMX USB | temps réel, matériel, difficile à reproduire ; en attente |

T1 est en dernier pour la difficulté, mais **mis en attente** : l'utilisateur joue en Art-Net. À reprendre plus tard, en mesurant avant de corriger.

Fait depuis ce relevé (2026-11-09) : **T7** (« rang » 1), **T17** (« rang » 2), **T31** (composé d'outils existants — le pad XY et les faders de canaux — d'où la place modeste qu'il occupe dans la liste ci-dessus) et **T33** (gestion des dossiers, née à la suite du T17).

## Plan d'action (mis à jour le 2026-11-07)
Principe : d'abord ce qui empêche de jouer, puis les gains rapides, puis les définitions saines (elles conditionnent le reste), puis le réglage des lyres, enfin le confort, le visuel et la manette. T1 (DMX USB) est en attente : l'utilisateur joue en Art-Net.

| Phase | Items | But | Fini quand |
|---|---|---|---|
| **0. Jouer proprement** | T2 ([plan-t2.md](plan-t2.md)), T4, T3 (avec sa précision sur les du groupe extérieur de l'utilisateur) | plus de flash en changeant de look, fader DCA juste, fondu respecté partout | un test moteur A → B → A passe ; le fader DCA garde sa course avec le lissage ; le fondu agit sur tous les projecteurs |
| **1. Gains rapides** | T7 fait, T17 fait, T33 fait, T31 fait, T12, T16, T14 | inversion pan/tilt, dossiers de looks, gestion des dossiers, panneau de la lyre sélectionnée, canaux du type choisi, instantané au démarrage, thématiques | chacun visible dans l'interface et couvert par un test UI |
| **2. Définitions saines** | T20a (détecter les doublons et avertir), T21, T22, T18 | plus de définition choisie au hasard, le Wash allume ses 3 zones, patch contrôlé, roue de couleurs fiable | « Vérifier le show » signale un doublon ; les 10 couleurs du Spot tombent sur la bonne case ; Wash 29 canaux piloté sur toutes les zones |
| **3. Réglage et mouvements des lyres** | T5, **T25 (conception, avec T29)**, T26, T11, T6, T9, T24, T32 (enregistrer et rappeler une position nommée), T27 | pistes fondables, couche Mouvement claire, verrou, menu de l'appareil, modes nommés, pad XY, cible 3D, presets de position, zones de visée | essai sur les vraies lyres ; T5 avant T6, T25 avant T24, T26 et T29, T24 avant T27 pour le pad |
| **4. Confort et contenu** | T15, T13, T20b (fusion, duplication, éditeur de définition), T8, T23, T30, T28 | intentions exportées, canevas, bibliothèque complète, calibration manuelle, triangulation, placement par angles, looks par zone | archive `.lightshow` aller-retour ; fusion sans changer adresses ni modes ; T23 avant T30 ; T27 et T25 avant T28 |
| **5. Visuel** | T19 | images de gobos | après T6 (miniatures dans la liste de plages) et T20b (où déposer les images) |
| **6. En fin de parcours** | T10 (manette : sticks et gâchettes, puis scènes de manette ; PS5 seulement après discussion), puis T1 (retour du DMX USB, en mesurant avant de corriger) | pilotage à la manette, USB à nouveau fiable | essai avec 2 lyres aux 2 sticks |

Après chaque phase : lancer `npm test`, `npm run typecheck` et `npm run test:ui`, mettre à jour [HANDOFF.md](HANDOFF.md) et la spec concernée, faire le grep de confidentialité, puis commiter.

## Questions à trancher avec l'utilisateur
Ouvertes :
- Quelle interface DMX USB exacte (Open DMX FTDI ou USB Pro) et quels univers y sont routés ? (T1, en attente)
- T16 : l'instantané de démarrage doit-il passer outre la sortie en veille ? (par prudence : non, tant que l'utilisateur n'a pas répondu)
- T6 : une variante de mode (plusieurs valeurs voisines) se présente en sous-menu ou dans le même menu ?
- T27 : formes de zones voulues (rectangle seulement, ou aussi ellipse et polygone) ?
- **T25 : priorité entre position manuelle, cible et mouvement du look** : reportée par l'utilisateur, à trancher à l'attaque de T25 (proposition de départ : manuelle > cible > look).
- **T32 : une position nommée porte une lyre, un groupe ou toutes** ; et ce que fait le rappel pendant qu'un look tourne (proposition de départ : la position manuelle l'emporte jusqu'à relâchement, comme aujourd'hui). Reportée, à trancher à l'attaque de T32.
- **T29 : deux looks ayant le même sous-look** : une instance partagée comptée par référence (proposition) ou une par parent ? Reportée, à trancher à l'attaque de T29.

Tranchées (2026-11-08) :
- T2 : un look relancé en plein fondu repart de son niveau courant **et** garde sa position dans l'animation.
- T26 : le verrou « Figer les lyres » a **deux niveaux** : souple (looks et cible bloqués, pad libre) et dur (tout, pad compris).
- T24 : chaque cible a **son groupe ou sa liste de lyres** ; plusieurs cibles en même temps.
