# MIDI, OSC et Ableton

## Périmètre
| v1 | Plus tard |
|---|---|
| Entrées locales (IAC, USB), RTP-MIDI, Web MIDI ; choix des entrées, auto-détection, profils d'entrées ; MIDI clock en sortie | Device Max for Live |
| Modes Déclencher / Latch / Momentané, learn, retour MIDI, profils de contrôleurs | Sauts et injection de notes vers AbleSet |
| Clock, SPP et suivi de position ; registre de notes ; suivi d'AbleSet | |
| Export MIDI Effect Rack, table des notes, `.mid`, générateur de Live Set | |
| Pilotage OSC avec explorateur d'adresses | |

## Entrées MIDI
| Source | Implémentation | Usage |
|---|---|---|
| Local | `@julusian/midi` (CoreMIDI sur macOS, ALSA sur Linux) | bus IAC depuis Ableton sur le même Mac, contrôleurs USB |
| RTP-MIDI | lib AppleMIDI | Ableton sur un autre poste, serveur distant (Pi, Docker, Linux) |
| Web MIDI | navigateur, puis `req POST /api/midi/in` | contrôleur branché sur un poste de dashboard (Chrome/Edge ; **pas Safari ni iPad**) |

- **Choix des entrées surveillées** : la page MIDI liste tous les ports et sessions, et l'utilisateur coche ceux à écouter.
- **Auto-détection** : hotplug des ports locaux, découverte des sessions RTP-MIDI (Bonjour/mDNS), notification « nouvelle entrée détectée ».
- **Profils d'entrées** par événement ou par lieu, stockés dans la config machine. Par exemple « local IAC » ou « RTP régie ». On **bascule d'un clic** entre MIDI local et RTP-MIDI.
- **Port RTP-MIDI occupé** (sur un Mac, la session réseau de macOS prend souvent 5004) : le serveur démarre quand même, sans session intégrée, et le signale dans ses journaux, `/health` et la page MIDI.
- **Indicateur d'activité** par entrée (reçoit, ou silencieuse) et moniteur MIDI (`light:midi`), avec la latence mesurée.
- Chaque message est normalisé en `{source, port, type, ch, num, val, ts}`. Le chemin MIDI → commande → moteur ne passe jamais par l'UI.

## Mapping
Un mapping associe une **entrée** (type note/CC/PC/pitch bend/aftertouch/NRPN, canal, numéro) à une **action** (commande serveur), avec un **mode**.

- **Le canal MIDI fait partie du mapping et est stocké dans le show**, jamais dans un réglage machine (retour d'expérience).
- **Actions** :
  - look, technique ou section (lancer, stopper) ;
  - niveau d'un groupe et grand master, mute et flash de groupe ;
  - GO et BACK de cue stack ;
  - tap tempo ;
  - chant et section (sélection, suivant, précédent) ;
  - dashboard ou page ;
  - palette ;
  - **Panic neutre**, **Blackout**, freeze ;
  - attribut du programmer.

### Modes de déclenchement
> Règle commune : **une note on à vélocité 0 vaut une note off.**

| Mode | Comportement | Usage type |
|---|---|---|
| **Déclencher** | Une note on **active toujours** et ne coupe jamais. Rejouer la même note est sans effet. Le relâchement vient du **groupe exclusif**. | Sections de chant. Il évite le piège Toggle de QLC+ et rend inoffensive une note dupliquée par Ableton. |
| **Latch** | Une note on active, la note on suivante sur la même note désactive. Les note off sont ignorées. | Boutons marche/arrêt |
| **Momentané** | Actif **tant que la note est tenue**. Le niveau d'un fader suit la vélocité. **Une nouvelle note on sur la même note pendant l'appui met le niveau à jour** (rejeu avec une autre pression), sans basculer. Option **« suivre l'aftertouch »** (poly ou canal). Note off ou vélocité 0 : coupe, fader à 0. | Flashs (la longueur de la note dans le clip fait la durée), faders joués en notes |

- **Mode par défaut** des nouveaux boutons : réglable dans l'UI, au niveau du show ou du dashboard. Déclencher est proposé par défaut pour les sections.
- **Mise à l'échelle** par mapping : plage d'entrée, plage de sortie, courbe (linéaire, log, exp, easing).
- **CC et pitch bend** : valeur absolue, **NRPN et CC 14 bits** (DMXIS), option **pickup** (soft takeover).
- **Canal réservé** (option, convention DMXIS) : un canal MIDI dédié à la sélection de chant, section ou preset par numéro de note ou Program Change.
- **Learn** : on clique un widget, on bouge le contrôleur, et le mapping est créé.
- **Profils de contrôleurs** (JSON, comme les input profiles de QLC+) : noms des contrôles et couleurs de LED selon la vélocité. Les messages d'init sont **explicites et optionnels**, rien n'est envoyé par défaut.

### Registre de notes (retour d'expérience)
- Une note attribuée à une action **ne change jamais de sens**. Un clip Ableton déjà posé déclenche toujours la même chose.
- Une note libérée reste **réservée**. Une collision ou une réattribution passe par une **proposition** validée par un humain, jamais en silence.
- **Bandes de notes** configurables par show, avec une **bande commune** (bibliothèque partagée) identique d'un show à l'autre pour permettre un rack Ableton commun.

### Dans l'interface (v1, page MIDI)
- **Entrées surveillées** : une case par port détecté (enregistrée dans le profil actif ; les motifs reconnaissent les noms par sous-chaîne, par exemple « IAC ») et la **sortie de retour**.
- **Mappings** : créer, modifier, supprimer ; entrée note, CC ou program change avec **« Apprendre »** (le prochain message reçu, 15 s) ; mode ; action : lancer un look, niveau d'un DCA (fader, CC), flash d'un DCA, lancer une section, **activer un programme de règles** (ou aucun), section ou chant suivant/précédent, tout arrêter, tap tempo, Panic neutre, Blackout ; retour note ou CC.

## Retour MIDI (feedback)
- Chaque mapping peut renvoyer son état : une note on dont la vélocité égale le niveau (ou vaut 127/0), une note off, ou un CC miroir. Le profil traduit l'état en couleur ou clignotement de LED.
- Le retour est émis à **chaque changement d'état, quelle que soit l'origine** : UI, MIDI, OSC, MCP, timeline.
- **Port de sortie distinct obligatoire.** Le serveur **refuse** un port de sortie identique à une entrée surveillée et **détecte les boucles**. QLC+ renvoyait l'état sur le bus d'entrée, et ses Toggle basculaient tout seuls.
- La page MIDI contient un **testeur de feedback** : allumer chaque LED et tester les couleurs.

## Horloge et position
- **MIDI clock** en entrée (24 ppqn), avec un asservissement logiciel (PLL), un lissage réglable et la détection d'arrêt. Start, Stop, Continue.
- **Song Position Pointer** : recalage de la position. Le serveur **rétablit la section courante** d'après la timeline du chant, ce qui permet une reprise en *scrub* au milieu d'une section.
- **Alerte « horloge attendue mais absente »** : sans le réglage Sync d'Ableton, rien ne suit le tempo et rien ne le signale. On rend donc ce cas visible.

### Horloge en sortie (v1)
- Le tempo de la lumière (manuel, tap, micro, DJ) peut partir en **horloge MIDI** : 24 tops par temps vers une sortie du profil MIDI (`clockOutput` : un nom de port, ou `rtp` pour la session RTP-MIDI ; page MIDI, « Horloge MIDI en sortie »), pour qu'Ableton ou une boîte à rythmes réglés pour la suivre gardent ce tempo.
- Calée sur le compteur de temps du moteur : un changement de tempo ou un rattrapage de phase part tel quel. Mesuré à ±1 ms de son instant (minuterie d'une milliseconde, 120 BPM). Après un blocage de la machine, un seul top, jamais une rafale.
- **Jamais de Start ni de Stop** : ils lanceraient ou arrêteraient le transport de ce qui suit. **Rien** pendant que le tempo suit lui-même une horloge MIDI (il la renverrait). Une sortie qui est aussi une entrée surveillée est **refusée**, comme pour le retour : le tempo suivrait sa propre horloge.

## Contrôle externe : OSC
- **Serveur OSC** (UDP, port configurable). Toutes les adresses passent par la couche de commandes et les droits du rôle. Exemples d'adresses :
  - `/light/song/{id}/select` ;
  - `/light/section/{id}/go` ;
  - `/light/group/{id}/level f` ;
  - `/light/button/{id}/press` ;
  - `/light/panic` ;
  - `/light/blackout` ;
  - `/light/tempo/tap`.
- **Explorateur OSC** : chaque objet (widget, chant, section, groupe) affiche son adresse avec un bouton **copier**. Une page liste toutes les adresses avec recherche.
- **Export de la table** OSC en Markdown, CSV ou JSON. La requête `/light/help` renvoie la liste.
- L'**API HTTP** équivalente (`POST /api/trigger/...`) sert à Companion et aux scripts.

## Logiciel DJ : OS2L (v1)
- **OS2L** (Open Sound to Light) : un logiciel DJ (VirtualDJ…) se connecte en **TCP** au serveur (port **7272**, réglable : `os2l.port`) et envoie des objets JSON à la suite : `beat` à chaque temps (BPM, position dans le morceau, `change` quand les temps sautent), `btn` pour un bouton de son pad (`on` / `off`), `cmd` pour une commande numérotée (un curseur de VirtualDJ, valeur de 0 à 1). Accès comme l'OSC : tout ordinateur du réseau, sauf si `os2l.allow` nomme les siens.
- **Tempo** : les temps du DJ mènent le tempo (source « os2l »), BPM et **phase** (rattrapée en deux temps, sans saut, comme le micro), sauf si l'**horloge MIDI** d'Ableton joue (elle mène, et reprend la main dès qu'elle revient quand le DJ menait faute d'horloge) ou si le **micro** du pupitre écoute. Choisir un tempo à la main (taper, tap, source) rend la main au pupitre.
- **Boutons** : un bouton lance, tant qu'il est « on », le **look de son nom** (nom ou id, sans tenir compte de la casse), sinon rappelle l'**instantané** de ce nom ; l'état du look revient sur le pad (`feedback`), y compris quand il est arrêté ailleurs. Origine « DJ (OS2L) » dans le journal et pour les règles (`appliesTo.origins`).
- **Commandes numérotées** (v1) : la commande n° N (0 à 127) arrive comme un **CC N** sur le port virtuel « OS2L » (sa valeur 0..1 devient 0..127) et passe par les **mappings** : niveau d'un DCA, fader de canaux, grand master, look… Un mapping se fait pour le DJ (page MIDI, « Source : DJ (OS2L) », ou « Apprendre » pendant que le DJ bouge son curseur) ; seuls ces mappings lui répondent, jamais ceux d'un contrôleur (« toutes les entrées »), et ils n'envoient pas de retour LED.
- **Découverte** : le service `_os2l._tcp` est annoncé en **mDNS** (instance « Lumière ») : le logiciel DJ trouve la régie tout seul ; sinon son réglage d'adresse directe (`os2lDirectIp` dans VirtualDJ) prend l'adresse affichée dans **Réglages → DJ (OS2L)**, avec les logiciels connectés, leur BPM et les derniers boutons. Vérifiable sur un Mac : `dns-sd -B _os2l._tcp local.`.

## AbleSet (v1)
- **AbleSet** (la setlist d'Ableton Live) dit en OSC quel chant et quelle section jouent (API publique : port UDP 39051, `/subscribe auto <port> <nom>`, puis `/setlist/activeSongName`, `/setlist/activeSectionName`, `/global/isPlaying` à chaque changement et `/heartbeat` toutes les 2 s ; `/getValues` pour l'état d'un coup). Le serveur s'abonne, et s'abonne à nouveau quand le battement de cœur manque (AbleSet relancé ou lancé après lui).
- **Suivi** : **pendant la lecture**, la section de **même nom** dans le chant de **même titre** (ou de même id, sans tenir compte de la casse) démarre, une fois par changement ; à l'arrêt, se déplacer dans AbleSet ne lance rien, et la reprise lance la section où elle repart. Comme la timeline d'un chant : jamais un look « manuel seulement », origine « AbleSet » dans le journal et pour les règles. Une section absente du show est signalée (page MIDI), rien ne démarre.
- **Réglage** (page MIDI, section AbleSet ; `ableset.configure`, gardé dans la config machine) : éteint par défaut ; la machine d'AbleSet (celle-ci par défaut) et son port. À ne pas cumuler avec des notes MIDI qui lancent les mêmes sections.

## Ableton
### Export MIDI Effect Rack (v1)
- **Une chaîne par action**, nommée comme elle, avec une **key zone d'une seule touche** (`KeyRange` Min = Max = note, crossfades idem). La chaîne s'allume quand sa note passe : c'est une légende vivante dans Live.
- `DocumentColorIndex` par bande, **rouge pour les actions danger ou manuelles**. `UserName` du device = « show · bande · canal », `Annotation` = légende des CC.
- **Méthode** : cloner `<MidiEffectBranchPreset>` depuis une **coquille** `.adg` exportée par la version de Live de l'utilisateur, non modifiée, et vérifier que tout le reste ressort octet pour octet. **On ne fabrique jamais le XML Live à la main.** Validé le 2026-10-14 : un rack généré depuis une vraie coquille se charge dans Live 12.4.5, alors qu'une coquille synthétique (celle des tests unitaires, `test/fixtures/shell-rack.xml`) est refusée par Live — elle ne sert qu'aux tests.
- Avertissement à l'export : **un rack = une piste**. Une note couverte par deux racks est dupliquée. Le mode Déclencher rend cette duplication inoffensive.
- Également exportés : la **table des notes** (CSV/Markdown) et un **`.mid` par chant** (la timeline en notes et CC).

### Générateur de Live Set (v1)
- Il pose la setlist dans un `.als` existant :
  - un repère par chant ;
  - un clip vide par section sur une piste « Sections » ;
  - un clip de notes autonome par section ;
  - un palier de tempo par chant.
- Les pistes sont trouvées **par nom**. Le reste du set ressort intact.
- **Mode hybride** : un élément déjà posé à la main garde sa position.
- Règles d'espacement entre sections et entre chants, configurables.
- Live doit être **fermé** pendant l'écriture. Une copie de sauvegarde est faite avant.

### Plus tard
- **Device Max for Live** : liste les actions du serveur et permet de les glisser sur la timeline (façon « Live Triggers » de Lightkey). Il nécessite Live Suite ou l'option Max for Live.
- **Vers AbleSet** : sauts commandés depuis la lumière (`/setlist/jumpToSong`, `/setlist/jumpToSection`), injection de notes pour l'auto-test.

### Programmes de règles dans Ableton (v1)
- **Clip par programme** (`export.ableton.programs`, CLI `light export programs`) : un clip `.alc` « Prière #100 » qui envoie le Program Change du programme au lancement, comme le clip « A #100 » de la piste « Show TAG » de l'utilisateur. Cloné depuis une coquille `.alc` exportée par Live (`data/private/shell.alc`) : seuls le nom et le Program Change du **premier** clip changent (les clips du groove pool restent intacts ; vérifié sur un vrai clip : 2 lignes modifiées). Le canal est celui de la sortie MIDI de la piste.
- **Fichier MIDI d'un chant** (`export.mid`, bouton ⤓ de la page Chants, CLI `light export mid`) : format 0, 96 ticks par temps (comme le fichier de clic de référence), tempo et mesure du chant ; à chaque section, la note qui lance son look (d'après les mappings, durée 1/16) et le Program Change de son programme. **Live ignore a priori les Program Change des fichiers MIDI importés** (à vérifier sur le Mac) : les clips de programmes les portent de façon sûre, et un **mapping de note** « activer un programme » (page MIDI) permet aussi de passer par une simple note.

## Tests
- Chaque mode avec des séquences de messages : note on à 0, rejeu pendant l'appui, aftertouch, note off orpheline, duplication.
- Retour sur port distinct et détection de boucle.
- Clock, PLL et SPP avec une horloge simulée.
- Registre : épinglage, réservation, collision bloquante.
- `.adg` généré : gunzip, XML valide, relecture des **noms de chaînes** et des key zones, et tout le reste identique à la coquille.
- `light selftest` : balayage de tous les mappings, relecture du DMX, cadence, exclusivité.
