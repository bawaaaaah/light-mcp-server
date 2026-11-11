# Sortie DMX : Art-Net, sACN et DMX USB

## Périmètre
| v1 | Plus tard |
|---|---|
| Art-Net 4 (découverte, routage, ArtSync), sACN E1.31 (multicast et unicast, priorités), **DMX USB** (Open DMX et USB Pro, 2026-10-22), jusqu'à **16 univers** | Art-Net en entrée (merge), ArtAddress (reconfigurer un node), RDM, découverte d'univers E1.31 |

## Art-Net 4
- Socket UDP sur le **port 6454**, broadcast, **choix de l'interface réseau** (dans la config machine) et bind IP.
- **Découverte** :
  - `ArtPoll` toutes les ~3 s et à la demande ;
  - décodage des `ArtPollReply` : IP, firmware, Net/Sub/SwOut (port-address 15 bits), noms court et long, NodeReport, ports, MAC, Status, BindIndex ;
  - un node est marqué « perdu » au bout de 10 s sans réponse ;
  - publication sur `light:nodes`.
- **Émission** :
  - `ArtDmx` avec séquence, envoyé selon le **mode d'envoi** de la route (2026-11-02, demandé par l'utilisateur) : **auto** (par défaut) en unicast vers les nodes qui annoncent l'adresse, broadcast en repli quand aucun ne l'annonce (`broadcast: false` coupe ce repli) ; **broadcast** à tout le réseau ; **nodes choisis** seulement vers les IP cochées (`targets`), sans broadcast, et rien du tout si aucune n'est cochée. Ce dernier mode sert quand un node branché en parallèle répond à tous les univers : il ne reçoit rien tant qu'on ne le coche pas. Une route enregistrée avant ce choix, avec des cibles, est en « nodes choisis » ;
  - keep-alive au moins toutes les 1 s ;
  - **ArtSync** optionnel en fin de frame.
- **Routage** : chaque univers interne est routé vers une ou plusieurs port-addresses ou IP. En mode auto, d'après le SwOut des nodes.
- **État des ports** (v1, `nodes.list`, page Réglages) : pour chaque port de sortie, ce que le node dit de lui-même dans *GoodOutputA* : de la DMX sort (bit 7, il reçoit des données pour son adresse), il écoute l'Art-Net ou le **sACN** (bit 0), fusion **LTP** (bit 1) ou HTP, fusion en cours (bit 3). Un node multi-port répond une fois par port (BindIndex) : chaque port est une ligne.
- **Routes réglables** (v1, `output.route`, page Réglages, droit `commands:output`) : par univers, **on coche ses sorties** (2026-10-22, demandé par l'utilisateur), une ou plusieurs : Art-Net (une adresse ; proposée : le numéro de l'univers moins 1), sACN (un univers ; proposé : le même numéro), DMX USB (une interface et son type, voir plus bas) ; aucune cochée, l'univers n'est pas envoyé. Chaque sortie réseau montre son mode d'envoi et les nodes concernés : en auto ceux qui annoncent l'adresse, en « nodes choisis » tous les nodes vus à cocher, plus les IP cochées qu'on ne voit plus (« pas vu sur le réseau ») ; un point vert marque ceux qui reçoivent l'univers maintenant, et « envoyé maintenant vers » donne les destinations réelles (`output.status` → `destinations`). Une IP cochée reste choisie quand on passe en auto ou en broadcast, pour y revenir ; une liste vide l'efface. Les cibles sont des IPv4 : une nouvelle entrée qui n'en est pas une est refusée, mais une cible déjà enregistrée (route d'une version plus ancienne) reste et n'empêche pas de modifier la route. Sans node qui annonce l'adresse, l'aide dit si la lumière part en broadcast ou, broadcast coupé, si rien n'est envoyé. La lumière part aussitôt vers la nouvelle adresse (renvoyée sans attendre le keep-alive) : l'interface le demande d'abord, sauf en veille ; la route est gardée dans la config machine.
- **Couverture** (v1, `output.status`) : une route Art-Net qui n'est pas en « nodes choisis » dont **aucun node vu ne sort l'adresse** (la lumière part en broadcast, pour personne) et les ports Art-Net qu'**aucune route n'alimente** sont signalés, avec un bouton pour envoyer l'univers sur un port libre. C'est le piège de la numérotation : Art-Net compte à partir de 0, et l'« univers 1 » d'un node ou de QLC+ est l'adresse 0 ou 1 selon le fabricant. Un port réglé en sACN n'est pas vérifié (l'ArtPollReply ne dit pas quel univers sACN il écoute).
- **Sortie qui n'arrive nulle part** (T38, 2026-11-11) : deux signaux de plus, dans `output.status` et sur la page Réglages, car un envoi vers une IP morte ne se voit pas côté moteur (le calcul est juste, les projecteurs restent éteints) et le compteur global `stats.errors` ne dit ni quelle cible ni quand.
  - `sendHealth` : le routeur compte, **par hôte cible**, les envois et les erreurs des 10 dernières secondes (`windowSeconds`) ; un hôte est `failing` quand il a reçu au moins 5 envois et que plus de la moitié a échoué (module pur `send-health.ts`, horloge passée en paramètre ; seuils nommés en constantes).
  - `coverage.misdirected` : une route en « nodes choisis » dont **aucune cible n'a été vue** par la découverte alors qu'un node vu sort l'adresse Art-Net de la route (il répond probablement depuis une autre IP, par exemple hors du sous-réseau). L'entrée donne la route, ses cibles et les nodes qui sortent l'adresse. Si une cible au moins est vue, rien n'est signalé.
  - Bandeau (un par univers, les deux raisons réunies s'il y a lieu) avec deux actions, chacune derrière la confirmation habituelle puisqu'elle change la config machine : « Recibler vers la node trouvée » (`output.route` en « nodes choisis » vers l'IP de la node, une par node proposée) et « Passer en broadcast » (masqué si la route l'est déjà). Pour un simple échec d'envoi sans node trouvée par `misdirected`, les nodes proposées sont celles vues qui sortent l'adresse et ne sont pas en échec.

## sACN (E1.31)
- Multicast `239.255.<hi>.<lo>`, port 5568, ou **unicast** vers les IP choisies (`unicast`) ; la page Réglages ne propose que les nodes qui ont un port en sACN (plus les IP déjà choisies), et une liste vide revient au multicast.
- CID persistant, nom de source, **priorité** de 0 à 200, paquets de sync.
- Protocole (Art-Net, sACN ou les deux), destination et priorité réglables **par univers**.

## DMX USB (2026-10-22)
Une interface branchée sur la machine, avec sa propre ligne DMX, sans réseau : celle de l'utilisateur dans QLC+ (« DMX USB », puce FTDI FT232R) en est une. Deux types, comme dans QLC+ :
- **Open DMX** (Enttec Open DMX USB, câbles FTDI FT232R) : la machine fait elle-même le signal DMX, 250 kbauds, 8 bits, 2 bits de stop : un *break* (1 ms), le code de départ et 512 canaux, en continu (≈ 36-39 trames par seconde : les projecteurs attendent un signal régulier ; la trame suivante attend que la précédente soit partie : au moins 22,6 ms (513 octets à 250 kbauds) + 2 ms après le début de son écriture, **quoi que dise `drain()`**, qui peut rendre la main avant que la puce ait fini d'émettre et laisser le break suivant couper la fin de la trame). DTR et RTS sont mis à 0 dès l'ouverture (l'OS les lève) et nommés à 0 à chaque break (c'est ce que `set()` a toujours laissé : les lignes ne bougent pas).
- **USB Pro** (Enttec DMX USB Pro et compatibles) : un message au boîtier (0x7E, label 6 « envoyer la DMX », longueur, code de départ et canaux, 0xE7), qui fait le signal et répète la dernière trame tout seul ; envoyé quand l'univers change et chaque seconde.
- Le port série vient du module `@serialport/bindings-cpp` (précompilé pour Mac et Linux, comme le module MIDI) ; `output.usb.list` liste les ports, puces FTDI d'abord ; sur Mac, le port `/dev/cu.*` (le `/dev/tty.*` attend un signal de modem). Le chemin choisi est gardé dans la route, dans la config machine (jamais dans le show).
- Une interface sort **un seul univers** (refusé sinon) et **un port n'a qu'un nom** : `/dev/tty.*` et `/dev/cu.*` sont le même appareil sur Mac (une seule boucle, le chemin est ramené à `/dev/cu.*` partout : routes, config, sorties). Deux routes sur le même port (config éditée à la main) : la première gagne, son univers seul est envoyé (l'interface ne reçoit plus deux univers à tour de rôle, ce qui la faisait clignoter). Chaque interface a sa boucle, à son rythme, et reçoit la dernière trame du moteur.
- **Rien ne part avant une vraie trame** : tant que le moteur n'a rien envoyé depuis l'ouverture (démarrage, sortie de veille), l'interface ne reçoit rien (des zéros seraient un flash noir), et la trame d'avant la veille n'est jamais réémise.
- **Débranchée ou en erreur** : l'erreur s'affiche (Réglages, « Interfaces DMX USB », `output.status` → `usb`), et l'interface est rouverte **vite, puis de moins en moins souvent** (250 ms, 500 ms, 1 s, puis toutes les 2 s) jusqu'à son retour : une erreur isolée ne coupe plus la ligne 2 s. `output.status` garde de quoi comprendre un clignotement : `reopens` (fermetures après erreur), `lastError` et `lastErrorAt` (conservés après le retour ; `error` ne dit que l'erreur en cours), et, en Open DMX, `maxGapMs` (le plus long intervalle entre deux trames depuis l'ouverture du port), `breakMs` (dernier break) et `drainMs` (dernière durée écriture → retour de `drain()`, ~22,6 ms si `drain()` attend la ligne ; bien moins : il ne l'attend pas). La même erreur est écrite au plus toutes les 30 s dans `prod.log`.
- **Veille** : un port série n'est tenu que par un programme à la fois : en veille, le serveur **lâche** ses interfaces (QLC+ peut les ouvrir) ; avant de les lâcher, il envoie **une dernière trame de zéros**, écrite sur la ligne (break compris) avant la fermeture du port, qui appartient à la boucle (une ligne laissée muette garde ce que les projecteurs montraient en dernier), puis, en reprenant la main, il les rouvre.
- Tests sans matériel : un faux port série (ouverture, break, écritures, débranchement) ; le serveur des tests d'interface n'utilise que lui, pour ne jamais toucher une vraie interface de la régie. À vérifier avec l'interface de l'utilisateur ([tests-mac](../tests-mac.md)).

## Buffers et router
- Un `Uint8Array(512)` par univers, avec un drapeau de changement. Le router compare avec la frame précédente et émet sur les protocoles configurés.
- Statistiques (paquets par seconde, erreurs) dans `getHealth()` et sur la page Lieu → Nodes.
- **Budget** : 16 univers à 44 Hz sans trame perdue ([roadmap](../roadmap.md), prototype P2).
- La sortie continue même si l'UI ou un plugin tombe.

## Veille et autre console (v1)
- **Sortie en veille** (`output.standby`, `light serve --standby | --live`, gardée au redémarrage) : le show tourne et suit le MIDI, rien n'est envoyé ; le retour MIDI est coupé aussi, et les interfaces DMX USB sont lâchées. En entrant en veille, le serveur envoie une dernière trame **à zéro** (3 fois) : un node qui fusionne garde la dernière trame d'une source muette ~10 s, et des zéros sont neutres en HTP. En sortant de veille, tous les univers et tout le retour MIDI repartent aussitôt.
- **Autre console** : tout ArtDmx reçu qui n'est pas la copie d'un paquet que le serveur vient d'envoyer (même séquence, même port-address, mêmes données, moins de 2 s : l'écho de sa propre diffusion) est signalé 3 s ; l'en-tête de l'interface alerte si le serveur envoie en même temps. Jamais d'exclusion par adresse : une autre instance ou QLC+ **sur la même machine**, même sur le port 6454, est signalée, avec la mention « cette machine ». Nécessite la découverte (port 6454).
- **Fusion côté node** : le bit 3 de *GoodOutput* de l'ArtPollReply (port en fusion) est remonté par port-address.
- Procédure complète : [bascule-qlc.md](../bascule-qlc.md).

## Couche machine
L'IP de l'interface et les adresses des nodes relèvent de la **machine** ou du **lieu**, jamais du show. QLC+ réécrivait l'IP dans le show à chaque sauvegarde.

## Tests
- Encodage et décodage avec des trames de référence.
- Faux node UDP en process : découverte, expiration, routage auto.
- Faux port série : trames Open DMX (break puis trame) et USB Pro, débranchement et retour, veille.
- Compatibilité vérifiée avec un visualiseur qui reçoit l'Art-Net (Capture, ASLS Studio) et avec Wireshark.
