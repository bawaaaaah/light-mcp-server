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

## sACN (E1.31)
- Multicast `239.255.<hi>.<lo>`, port 5568, unicast possible.
- CID persistant, nom de source, **priorité** de 0 à 200, paquets de sync.
- Protocole (Art-Net, sACN ou les deux), destination et priorité réglables **par univers**.

## Buffers et router
- Un `Uint8Array(512)` par univers, avec un drapeau de changement. Le router compare avec la frame précédente et émet sur les protocoles configurés.
- Statistiques (paquets par seconde, erreurs) dans `getHealth()` et sur la page Lieu → Nodes.
- **Budget** : 16 univers à 44 Hz sans trame perdue ([roadmap](../roadmap.md), prototype P2).
- La sortie continue même si l'UI ou un plugin tombe.

## Couche machine
L'IP de l'interface et les adresses des nodes relèvent de la **machine** ou du **lieu**, jamais du show. QLC+ réécrivait l'IP dans le show à chaque sauvegarde.

## Tests
- Encodage et décodage avec des trames de référence.
- Faux node UDP en process : découverte, expiration, routage auto.
- Compatibilité vérifiée avec un visualiseur qui reçoit l'Art-Net (Capture, ASLS Studio) et avec Wireshark.
