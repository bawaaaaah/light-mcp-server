# Sortie DMX : Art-Net et sACN

## Périmètre
| v1 | Plus tard |
|---|---|
| Art-Net 4 (découverte, routage, ArtSync), sACN E1.31 (multicast et unicast, priorités), jusqu'à **16 univers** | Art-Net en entrée (merge), ArtAddress (reconfigurer un node), RDM, découverte d'univers E1.31 |

## Art-Net 4
- Socket UDP sur le **port 6454**, broadcast, **choix de l'interface réseau** (dans la config machine) et bind IP.
- **Découverte** :
  - `ArtPoll` toutes les ~3 s et à la demande ;
  - décodage des `ArtPollReply` : IP, firmware, Net/Sub/SwOut (port-address 15 bits), noms court et long, NodeReport, ports, MAC, Status, BindIndex ;
  - un node est marqué « perdu » au bout de 10 s sans réponse ;
  - publication sur `light:nodes`.
- **Émission** :
  - `ArtDmx` avec séquence, en **unicast** vers les nodes concernés, broadcast en repli optionnel ;
  - keep-alive au moins toutes les 1 s ;
  - **ArtSync** optionnel en fin de frame.
- **Routage** : chaque univers interne est routé vers une ou plusieurs port-addresses ou IP. En mode auto, d'après le SwOut des nodes.
- **État des ports** (v1, `nodes.list`, page Réglages) : pour chaque port de sortie, ce que le node dit de lui-même dans *GoodOutputA* : de la DMX sort (bit 7, il reçoit des données pour son adresse), il écoute l'Art-Net ou le **sACN** (bit 0), fusion **LTP** (bit 1) ou HTP, fusion en cours (bit 3). Un node multi-port répond une fois par port (BindIndex) : chaque port est une ligne.
- **Routes réglables** (v1, `output.route`, page Réglages, droit `commands:output`) : par univers, une adresse Art-Net et/ou un univers sACN, l'un ou l'autre vide ; les cibles IP fixées à la main restent. La lumière part aussitôt vers la nouvelle adresse (renvoyée sans attendre le keep-alive) : l'interface le demande d'abord, sauf en veille ; la route est gardée dans la config machine.
- **Couverture** (v1, `output.status`) : une route Art-Net sans cible fixe dont **aucun node vu ne sort l'adresse** (la lumière part en broadcast, pour personne) et les ports Art-Net qu'**aucune route n'alimente** sont signalés, avec un bouton pour envoyer l'univers sur un port libre. C'est le piège de la numérotation : Art-Net compte à partir de 0, et l'« univers 1 » d'un node ou de QLC+ est l'adresse 0 ou 1 selon le fabricant. Un port réglé en sACN n'est pas vérifié (l'ArtPollReply ne dit pas quel univers sACN il écoute).

## sACN (E1.31)
- Multicast `239.255.<hi>.<lo>`, port 5568, unicast possible.
- CID persistant, nom de source, **priorité** de 0 à 200, paquets de sync.
- Protocole (Art-Net, sACN ou les deux), destination et priorité réglables **par univers**.

## Buffers et router
- Un `Uint8Array(512)` par univers, avec un drapeau de changement. Le router compare avec la frame précédente et émet sur les protocoles configurés.
- Statistiques (paquets par seconde, erreurs) dans `getHealth()` et sur la page Lieu → Nodes.
- **Budget** : 16 univers à 44 Hz sans trame perdue ([roadmap](../roadmap.md), prototype P2).
- La sortie continue même si l'UI ou un plugin tombe.

## Veille et autre console (v1)
- **Sortie en veille** (`output.standby`, `light serve --standby | --live`, gardée au redémarrage) : le show tourne et suit le MIDI, rien n'est envoyé ; le retour MIDI est coupé aussi. En entrant en veille, le serveur envoie une dernière trame **à zéro** (3 fois) : un node qui fusionne garde la dernière trame d'une source muette ~10 s, et des zéros sont neutres en HTP. En sortant de veille, tous les univers et tout le retour MIDI repartent aussitôt.
- **Autre console** : tout ArtDmx reçu qui n'est pas la copie d'un paquet que le serveur vient d'envoyer (même séquence, même port-address, mêmes données, moins de 2 s : l'écho de sa propre diffusion) est signalé 3 s ; l'en-tête de l'interface alerte si le serveur envoie en même temps. Jamais d'exclusion par adresse : une autre instance ou QLC+ **sur la même machine**, même sur le port 6454, est signalée, avec la mention « cette machine ». Nécessite la découverte (port 6454).
- **Fusion côté node** : le bit 3 de *GoodOutput* de l'ArtPollReply (port en fusion) est remonté par port-address.
- Procédure complète : [bascule-qlc.md](../bascule-qlc.md).

## Couche machine
L'IP de l'interface et les adresses des nodes relèvent de la **machine** ou du **lieu**, jamais du show. QLC+ réécrivait l'IP dans le show à chaque sauvegarde.

## Tests
- Encodage et décodage avec des trames de référence.
- Faux node UDP en process : découverte, expiration, routage auto.
- Compatibilité vérifiée avec un visualiseur qui reçoit l'Art-Net (Capture, ASLS Studio) et avec Wireshark.
