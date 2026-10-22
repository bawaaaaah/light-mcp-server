# Interface web et dashboards

Stack : Vite + React + TypeScript, `react-grid-layout`, client WebSocket (`web/src/ws/client.ts` : enveloppe `t/id/topic`, corrélation req/res, réabonnement automatique). **IA en live** : case de la barre de la page Show (réglage `liveAi`) ; tant qu'elle est cochée, un badge « ✦ IA en live » s'affiche dans l'en-tête de toutes les pages (vers la page Show). **FR + EN dès la v1** : tous les textes passent par `web/src/i18n` ; l'interface envoie sa langue (`x-light-lang`) et le serveur lui répond dans la même (erreurs, « Vérifier le show », rapports d'import et d'auto-test ; `core/lang.ts`). Dark mode, raccourcis clavier partout, undo illimité, autosave, assistant de premier démarrage (Lightkey).

## Rôles et visibilité
- **Connexion** : d'abord le **jeton d'authentification** (`server.authToken`, droits d'administrateur), puis une **clé de sécurité** (quand une clé est enregistrée et que l'adresse le permet), puis, en dessous, un **PIN** pour un utilisateur choisi dans la liste (seuls les utilisateurs qui ont un PIN y figurent). Deux liens connectent directement, puis s'effacent de la barre d'adresse : `#token=<jeton>` (app de barre de menus) et `#user=<rôle>&pin=<PIN>` (**lien de partage**, créé dans Réglages). Les essais de PIN sont limités à 5 par minute et par adresse. Le lien de partage s'affiche aussi en **QR code** (bouton « QR code », sur demande puisqu'il contient le PIN) : l'appareil photo d'une tablette ouvre l'interface connectée ([architecture](../architecture.md)).
- Chaque rôle voit seulement les pages, dashboards et widgets autorisés. Une page demande le droit de ses commandes (Live : `dashboards:view` ; Chants, Show, Lieu, OSC, Import, Fichiers, Notes, Réglages : `show:write` ; Console DMX : `commands:dmx` ; MIDI : `midi:configure` ; Connexion IA : `mcp:use` ; Mon compte : tous). Sur le Live, un contrôle dont le rôle n'a pas le droit est grisé (DCA et faders : `commands:level`, Tap : `commands:tempo`, lyres : `commands:position`…) ; le crayon et le clic droit demandent `show:write`. Le serveur refuse le reste de toute façon, MCP compris.
- **Mise en page** : sur ordinateur, une barre latérale aux pages groupées (Jouer, Concevoir, Connecter, Données, Système) ; sur tablette, des onglets qui passent à la ligne (toutes les pages visibles) ; sur téléphone, une bande d'onglets qui défile, au bord droit estompé, la page ouverte toujours en vue ; en haut, le show ouvert, l'état de la sortie, la connexion, le nom de l'utilisateur (vers **Mon compte**), la langue et Quitter. Sur téléphone, la grille des dashboards passe à 4 colonnes dans l'ordre de lecture, et les tableaux défilent dans la page. Un bouton de look au nom coupé le donne en entier au survol. **Installable** sur l'écran d'accueil d'une tablette (manifeste web, icône, ouverture sur le Live sans barres du navigateur). Le tour Playwright (`test/ui/tour.spec.ts`) vérifie chaque page de chaque rôle, sur ordinateur, tablette et téléphone, en anglais, et sur un show vide.

## Pages
| Page | Contenu |
|---|---|
| **Live** | dashboards |
| **Console DMX** | un fader par canal, un onglet par univers ; par défaut les **canaux patchés groupés par projecteur** (nom du projecteur et de chaque canal), « Les 512 canaux » pour tout voir (choix mémorisé dans le navigateur) ; valeur, **source** en couleur ; forçage (park), double-clic pour relâcher ; détail des groupes et règles au survol |
| **Lieu** | fixtures (bibliothèque, import OFL/`.qxf`, éditeur), patch, nodes Art-Net/sACN et routage |
| **Scène** | vue de dessus et vue de face, zones, rôles, calibration, post-it ; live preview 2D |
| **Canevas** | définition des canevas et de leur rendu sur le kit |
| **Groupes** | arbre des groupes : master, exclusif, limites, presets inclus ou exclus ([groups-masters](groups-masters.md)) |
| **Looks et techniques** | looks (pastille de leur couleur dominante ; au-delà de 8, **recherche** par nom, technique ou tag et filtre par **dossier** QLC+ importé), techniques, effets, cue stacks, palettes, presets ; faders de canaux avec le **nom des projecteurs et des canaux** pilotés ; **instantanés** (enregistrer l'état actuel, rappeler, remplacer) et choix du **secours** du Panic (instantané ou look) |
| **Éditeur d'effets** | voir plus bas |
| **Chants** | setlist, grille de chant, boutons, timeline, **planche**, feuille de conduite |
| **MIDI** | entrées détectées et surveillées, profils d'entrées (local ou RTP), moniteur, mappings, learn, registre de notes, testeur de feedback, export Ableton ; mappings triés par canal puis numéro (notes, CC, program change), recherche au-delà de 8 |
| **OSC** | explorateur d'adresses (recherche, copier), export de la table |
| **Import** | guidé en 4 étapes : 1. définitions `.qxf` (nombre dans la bibliothèque, ajout depuis le navigateur vers `data/fixtures`) ; 2. workspace `.qxw` importé **dans le show ouvert** (réimportation qui garde les retouches) ou **dans un nouveau show** (avec son propre lieu ou sur le lieu ouvert), proposition puis application, définitions manquantes signalées et proposition recalculée dès qu'on en ajoute ; 3. reconstruction en techniques ; 4. auto-test |
| **Notes** | recherche globale ; regroupées par type (looks, groupes, projecteurs…), repliables au-delà de 20 (un import en écrit une par look), une ligne par note, modifiée sur place d'un clic |
| **Fichiers** | fichier `.lightshow` du show ouvert (télécharger, restaurer avec aperçu des différences), show ouvert (renommer), liste des shows (ouvrir, dupliquer, supprimer), nouveau show (vide ou copie, même lieu, copie du lieu ou lieu vide), sauvegardes `.lightshow` du serveur (enregistrer, restaurer, télécharger), réinitialisation (administrateur) ; le nom du show ouvert est dans l'en-tête et y mène |
| **Connexion IA** | adresse MCP et jeton (masqué, à copier), marche à suivre par client (Claude Code, Claude Desktop, claude.ai, stdio, Inspector, curl), publication derrière un reverse proxy ; réservée aux rôles qui ont `mcp:use` |
| **Réglages** | sortie et nodes, **utilisateurs** (nom, rôle, PIN, clés de sécurité, actif, supprimer ; pas sa propre ligne), **rôles et droits** (tableau des droits par rôle — dont `show:propose`, proposer des changements sans les écrire, inclus dans `show:write` —, dashboards visibles, ajout et suppression des rôles personnalisés), **liens de partage** (utilisateur + PIN) ; liens « sur cette page » ; **en ligne maintenant** (chaque page ouverte : utilisateur, rôle, adresse, depuis quand ; `GET /api/clients`, droit `show:write`) et **activité récente** (qui, d'où, quoi, sur quel objet, sur la dernière semaine ; filtres par personne, par origine, erreurs seulement ; une rafale sur un même objet tient en une ligne) |
| **Mon compte** | qui est connecté, ses **clés de sécurité** (ajout, retrait), son PIN ; entré avec le jeton, la page propose de créer son compte administrateur pour y attacher une clé |

## Dashboards
- Modèle `{id, name, columns, widgets[], notes}`, stocké dans le show et synchronisé entre clients (`light:dashboards`).
- **Gérer les dashboards** depuis l'interface (mode édition) : renommer, nouveau, dupliquer, **générer depuis le show** (sécurité, un bouton par look, DCA et faders), supprimer (pas le dernier).
- **Palette** (mode édition) : les types de widgets, et les looks et instantanés du show (cherchables, avec la couleur de chaque look), à **glisser sur la grille** à l'endroit voulu ou à cliquer pour ajouter en bas. **Annuler / rétablir** (⌘Z, ⇧⌘Z ; un glisser compte pour un pas). En édition, la grille garde de la place pour déposer, même vide. **Sur tablette** (v1), un doigt posé sur un widget le déplace : les cases vides de la grille font défiler, et une **bande hachurée** collée au bord droit, toujours visible même quand la grille défile de côté, fait défiler dans les deux sens.
- Widget **Instantané** : un bouton qui rappelle un instantané (droit `commands:snapshot`) ; aussi en action MIDI.
- **Pour commencer** (Live) : tant que le show n'est pas jouable (pas de projecteur patché, pas de canevas, pas de look, ou aucun dashboard avec autre chose que la barre de sécurité), un guide en quatre étapes s'affiche **sous** la grille (la barre de sécurité reste en haut) : patcher (page Lieu ou import QLC+), un canevas avec tout le patch en un clic, les presets automatiques, générer le dashboard affiché. Masquable par show (navigateur) ; un rôle qui ne modifie pas le show lit seulement que le show est vide. Les pages vides (patch, console DMX, look par intention, chants) disent aussi quoi faire.
- **Chargement** : le Live part seul au premier chargement ; les autres pages (Show, Lieu, Chants, Réglages…) se chargent quand on les ouvre (−24 % au démarrage d'une tablette).
- **Légèreté** : l'interface lit les looks en résumé (`look.list`, résumé par défaut : nom, état, couleur, drapeaux, technique sans ses pas) et ne charge un look entier (`look.get`) que pour l'éditer : un appui sur le Live fait relire la liste à chaque page ouverte, et les pas exacts d'un show importé pèsent près d'1 Mo.
- **Plein écran** (Live) : seulement les dashboards, sans barre latérale ni barre du haut, pour jouer sur une tablette ou un écran de régie ; l'**écran reste allumé** (Screen Wake Lock, en HTTPS ou sur localhost) pour qu'une tablette ne s'endorme pas pendant le service ; Échap en sort.
- **Mode édition** (ajouter, déplacer, redimensionner, configurer) et **mode live**. En édition, la grille s'affiche ; on **glisse** un widget pour le déplacer et on tire **un de ses coins** pour le redimensionner ; un widget lâché sur d'autres les pousse vers le bas. **Grille magnétique** activable : déplacements et tailles case par case, ou au quart de case quand elle est coupée (positions au quart de case dans le modèle). **Colonnes** réglables jusqu'à 64 : au-delà de ce que l'écran montre (84 px minimum par colonne, 56 px sur tablette pour qu'un dashboard de 12 colonnes y tienne), le dashboard **défile vers la droite**, pour une interface en longueur.
- **Clic droit** sur un widget, en mode live comme en édition (sur tablette : **appui long**, sauf sur un bouton momentané ou un fader, qu'on tient ou qu'on glisse) : ce qu'il pilote (look lancé, DCA, fader de canaux), libellé, mode du bouton, **couleur**, notes et CC MIDI qui le jouent (« Apprendre », retrait), retrait du dashboard ; enregistré aussitôt. Le menu s'ouvre là où l'on clique et reste dans l'écran d'après sa taille réelle ; il ne s'élargit jamais au-delà de 340 px (ou de l'écran d'un téléphone) : un nom de look long passe à la ligne ou se coupe dans la liste, sans défilement de côté.
- **Couleurs** : chaque widget peut prendre une couleur (nuancier de 12 ou couleur libre), ou « auto » pour un bouton de look (la couleur dominante de son look, `swatch` de `look.list`) ; « Couleurs auto » en mode édition l'applique à tous les boutons de looks sans couleur. Un bouton coloré est teinté au repos et plein, avec un halo, quand il joue ; un fader prend sa couleur ; Panic reste toujours un bloc plein.
- **Bascule** par onglets, raccourcis 1‑9, URL `/d/:id`, MIDI, OSC ou sélection d'un chant. On peut dupliquer, importer et exporter.
- **Groupes de widgets** : on sélectionne des boutons ou faders et on les regroupe en un clic. Le groupe peut être **exclusif** et recevoir **sur demande un fader master** proportionnel ([groups-masters](groups-masters.md)).
- **Mode par défaut des nouveaux boutons** (Déclencher, Latch, Momentané), réglable par show, dashboard ou groupe.
- **Mode de chaque bouton** (v1, boutons de look et Blackout, choisi dans l'éditeur du dashboard) : **Marche / arrêt** (latch, par défaut : un appui allume, le suivant éteint), **Tant qu'on appuie** (momentané : actif pendant l'appui, relâché même si le doigt sort du bouton ; un repère ⇣ l'indique), **Déclencher** (allume toujours, ne coupe jamais ; repère ▸). En mode édition, un appui sélectionne le widget sans rien déclencher.
- **À confirmer** (v1, case du menu d'un bouton de look, de Blackout ou d'instantané, `confirm` du widget) : le premier appui arme le bouton (cadre pointillé fixe, « Appuyer encore ») pendant 3 s, le second le déclenche. Seul l'allumage demande confirmation : arrêter un look ou sortir du Blackout est immédiat. Pas pour un bouton momentané (le tenir est déjà délibéré), ni pour le MIDI (un pad est un doigt).
- Les widgets sont **liés à des groupes, rôles ou canevas**, jamais à des canaux. On dispose de **modèles de widgets** et du **reciblage en masse** (douleur QLC+).
- **Overlay de playbacks** (Onyx) : un panneau escamotable avec les groupes et playbacks, accessible depuis toutes les pages.

### Widgets
- **Bouton** : look, technique, section ou action, avec son mode.
- **Fader de groupe** : niveau effectif en grisé, mute, flash, marqueur max.
- Fader de canal DMX.
- **Grand master** (v1) : un fader qui dose tout le show, au-dessus des DCA (`grandmaster.set`), avec son action MIDI ; un autre écran qui le bouge le fait bouger ici.
- **Pad XY pan/tilt** (v1) : X = pan, Y = tilt, sur les lyres d'un groupe (ou toutes) ; envoi limité à 25 par seconde pendant le glissé ; « ⟲ » rend les lyres aux looks. Ajouté au dashboard par défaut quand le lieu a des lyres. **Pad XY de scène** : plus tard.
- Color picker et palette.
- Cue list.
- **Molette de cadence** : BPM, tap, source, voyant « horloge reçue » et alerte si absente. Le widget Tap montre le tempo dans un **champ qu'on peut taper** (v1) : un BPM puis Entrée (virgule acceptée) en fait le tempo manuel et coupe le micro ; Échap annule ; quitter le champ sans rien taper n'envoie rien. Il porte aussi un bouton **🎤** (v1) : le micro de l'appareil écoute la salle et le tempo suit la musique, temps compris ([tempo au micro](engine-effects-timing.md)) ; le bouton s'allume quand le tempo est suivi et affiche le BPM entendu.
- **Contrôleur FX façon Wolfmix** : vitesse, taille, phase, couleurs.
- **Panic neutre** (rappelle l'instantané de secours, sinon le look de secours, sinon Blackout) et **Blackout**. Le secours se choisit dans la page Show. Pendant **une minute** après un Panic, « ↶ Revenir » apparaît à côté (`panic.undo`, même droit que le Panic) : il remet ce qui jouait juste avant (looks, DCA, faders, grand master, programme, Blackout) ; les forçages de la console DMX et les lyres visées à la main que le Panic a relâchés le restent. Un Panic répété sans rien changer entre-temps garde l'état d'avant le premier.
- Momentanés : strobe (fader désigné), fumée, blinder.
- Sélecteur de chant ou de setlist.
- Label ou cadre, mini moniteur DMX, mini preview 2D (v1 : widget « Scène en direct », le plan de la page Lieu en compact), note épinglée.

### Indicateurs
- **Danger** (rouge) : flashs et strobe.
- **Manuel seulement** : sections `manualOnly`.
- **Conflit** : deux looks se disputent des fixtures.
- **Règle appliquée** : bornage, avec sa provenance.
- **Entrée MIDI** active ou silencieuse.
- **Liaison coupée** (rouge, en haut) : plus de 3 s sans liaison avec le serveur ; les boutons ne répondent pas.
- **Nouvelle version** (v1, en haut) : après une mise à jour, un onglet resté ouvert garde l'ancienne interface, bugs corrigés compris, tant qu'on ne le recharge pas (cas réel : un menu du clic droit corrigé qui débordait encore). La page compare le script qu'elle a chargé à celui que la page du serveur charge maintenant, au retour de la liaison (un redémarrage), quand l'onglet revient au premier plan et toutes les 10 minutes ; si elle diffère, un bandeau propose « Recharger ». Jamais de rechargement forcé : quelqu'un peut être en train de modifier un look.

## Sauvegarde
- **Télécharger** le show (et/ou le lieu) en archive **`.lightshow`**.
- **Recharger** une archive, avec un aperçu des différences avant d'appliquer (v1).
- Liste des backups automatiques ([data-cli-sdk](data-cli-sdk.md)).

## Éditeur d'effets, d'easing et de timing
- **Éditeur de looks** (v1, page Show) : technique et ses paramètres, palette par référence, miroir, cadence (temps ou secondes), attaque, ordre et poids, fondu d'entrée, Move FX des lyres, drapeaux, tags et notes ; enregistrer, enregistrer et lancer, dupliquer, supprimer.
  - Le formulaire des paramètres est **généré depuis le schéma du serveur** (`look.techniques`) : une nouvelle technique ou un nouveau paramètre apparaît sans code d'interface.
  - L'**aperçu animé** rejoue les pas calculés par le serveur (`look.preview`, le même générateur que le show) au tempo courant.
- **Aperçu animé** sur la scène : plus tard.
- **Éditeur de pas** (v1, technique `pas`) : une ligne par pas, un carré par cellule, pinceau couleur / éteint / non piloté, dupliquer ou supprimer un pas.
- **Courbe d'easing** : poignées bezier, presets de Penner, `steps`.
- **Timeline** fade, hold et delay, avec une bascule **secondes ↔ temps musicaux**.
- Visualisation du spread et de la phase.
- « Store » disponible partout : console DMX, scène, programmer.

## Tests
- Composants critiques (fader de groupe, bouton et ses modes, molette) en tests unitaires.
- Parcours Playwright : bascule de dashboard, édition et regroupement, téléchargement et rechargement d'une sauvegarde, i18n FR/EN, visibilité selon le rôle.
