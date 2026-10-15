# Interface web et dashboards

Stack : Vite + React + TypeScript, `react-grid-layout`, client WebSocket (`web/src/ws/client.ts` : enveloppe `t/id/topic`, corrélation req/res, réabonnement automatique). **FR + EN dès la v1** : tous les textes passent par `web/src/i18n`. Dark mode, raccourcis clavier partout, undo illimité, autosave, assistant de premier démarrage (Lightkey).

## Rôles et visibilité
- **Connexion** : d'abord le **jeton d'authentification** (`server.authToken`, droits d'administrateur), puis une **clé de sécurité** (quand une clé est enregistrée et que l'adresse le permet), puis, en dessous, un **PIN** pour un utilisateur choisi dans la liste (seuls les utilisateurs qui ont un PIN y figurent). Deux liens connectent directement, puis s'effacent de la barre d'adresse : `#token=<jeton>` (app de barre de menus) et `#user=<rôle>&pin=<PIN>` (**lien de partage**, créé dans Réglages). Les essais de PIN sont limités à 5 par minute et par adresse. Comptes nominatifs et QR viendront plus tard ([architecture](../architecture.md)).
- Chaque rôle voit seulement les pages, dashboards et widgets autorisés. Un widget interdit est masqué ou grisé.

## Pages
| Page | Contenu |
|---|---|
| **Live** | dashboards |
| **Console DMX** | un fader par canal, un onglet par univers, rendu virtualisé ; nom fixture/attribut, valeur, **source** en couleur ; forçage (park) ; détail des groupes et règles au survol |
| **Lieu** | fixtures (bibliothèque, import OFL/`.qxf`, éditeur), patch, nodes Art-Net/sACN et routage |
| **Scène** | vue de dessus et vue de face, zones, rôles, calibration, post-it ; live preview 2D |
| **Canevas** | définition des canevas et de leur rendu sur le kit |
| **Groupes** | arbre des groupes : master, exclusif, limites, presets inclus ou exclus ([groups-masters](groups-masters.md)) |
| **Looks et techniques** | looks, techniques, effets, cue stacks, palettes, presets ; **instantanés** (enregistrer l'état actuel, rappeler, remplacer) et choix du **secours** du Panic (instantané ou look) |
| **Éditeur d'effets** | voir plus bas |
| **Chants** | setlist, grille de chant, boutons, timeline, **planche**, feuille de conduite |
| **MIDI** | entrées détectées et surveillées, profils d'entrées (local ou RTP), moniteur, mappings, learn, registre de notes, testeur de feedback, export Ableton |
| **OSC** | explorateur d'adresses (recherche, copier), export de la table |
| **Notes** | recherche globale |
| **Fichiers** | show ouvert (renommer), liste des shows (ouvrir, dupliquer, supprimer), nouveau show (vide ou copie, même lieu, copie du lieu ou lieu vide), sauvegardes `.lightshow` du serveur (enregistrer, restaurer, télécharger), réinitialisation (administrateur) ; le nom du show ouvert est dans l'en-tête et y mène |
| **Connexion IA** | adresse MCP et jeton (masqué, à copier), marche à suivre par client (Claude Code, Claude Desktop, claude.ai, stdio, Inspector, curl), publication derrière un reverse proxy ; réservée aux rôles qui ont `mcp:use` |
| **Réglages** | réseau, tempo, **utilisateurs** (nom, rôle, PIN, clés de sécurité, actif, supprimer), **clés de sécurité** (les siennes, ou toutes pour l'administrateur), **liens de partage** (utilisateur + PIN), plugins (formulaires générés), langue, **sauvegarde** |

## Dashboards
- Modèle `{id, name, columns, widgets[], notes}`, stocké dans le show et synchronisé entre clients (`light:dashboards`).
- **Mode édition** (ajouter, déplacer, redimensionner, configurer) et **mode live**.
- **Bascule** par onglets, raccourcis 1‑9, URL `/d/:id`, MIDI, OSC ou sélection d'un chant. On peut dupliquer, importer et exporter.
- **Groupes de widgets** : on sélectionne des boutons ou faders et on les regroupe en un clic. Le groupe peut être **exclusif** et recevoir **sur demande un fader master** proportionnel ([groups-masters](groups-masters.md)).
- **Mode par défaut des nouveaux boutons** (Déclencher, Latch, Momentané), réglable par show, dashboard ou groupe.
- **Mode de chaque bouton** (v1, boutons de look et Blackout, choisi dans l'éditeur du dashboard) : **Marche / arrêt** (latch, par défaut : un appui allume, le suivant éteint), **Tant qu'on appuie** (momentané : actif pendant l'appui, relâché même si le doigt sort du bouton ; un repère ⇣ l'indique), **Déclencher** (allume toujours, ne coupe jamais ; repère ▸). En mode édition, un appui sélectionne le widget sans rien déclencher.
- Les widgets sont **liés à des groupes, rôles ou canevas**, jamais à des canaux. On dispose de **modèles de widgets** et du **reciblage en masse** (douleur QLC+).
- **Overlay de playbacks** (Onyx) : un panneau escamotable avec les groupes et playbacks, accessible depuis toutes les pages.

### Widgets
- **Bouton** : look, technique, section ou action, avec son mode.
- **Fader de groupe** : niveau effectif en grisé, mute, flash, marqueur max.
- Fader de canal DMX.
- **Pad XY pan/tilt** (v1) : X = pan, Y = tilt, sur les lyres d'un groupe (ou toutes) ; envoi limité à 25 par seconde pendant le glissé ; « ⟲ » rend les lyres aux looks. Ajouté au dashboard par défaut quand le lieu a des lyres. **Pad XY de scène** : plus tard.
- Color picker et palette.
- Cue list.
- **Molette de cadence** : BPM, tap, source, voyant « horloge reçue » et alerte si absente.
- **Contrôleur FX façon Wolfmix** : vitesse, taille, phase, couleurs.
- **Panic neutre** (rappelle le look de secours du show, sinon Blackout) et **Blackout**. Le look de secours se choisit dans les réglages du show, et le bouton indique s'il est défini.
- Momentanés : strobe (fader désigné), fumée, blinder.
- Sélecteur de chant ou de setlist.
- Label ou cadre, mini moniteur DMX, mini preview 2D (v1 : widget « Scène en direct », le plan de la page Lieu en compact), note épinglée.

### Indicateurs
- **Danger** (rouge) : flashs et strobe.
- **Manuel seulement** : sections `manualOnly`.
- **Conflit** : deux looks se disputent des fixtures.
- **Règle appliquée** : bornage, avec sa provenance.
- **Entrée MIDI** active ou silencieuse.

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
