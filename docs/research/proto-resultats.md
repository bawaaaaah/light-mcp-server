# Résultats des prototypes (étape 0)

Mode d'emploi : [prototypes/README.md](../../prototypes/README.md). Sauf mention contraire, les mesures datent du 2026-10-13, sur la machine de dev (Linux x86_64, Node 26).

## Synthèse
| # | Sujet | État | En une ligne |
|---|---|---|---|
| P1 | MIDI local (IAC, USB) depuis Node, hotplug, latence | ⏳ **à faire sur le Mac** | Module natif précompilé pour macOS, Linux (dont ARM) et Windows. Sans séquenceur ALSA, l'échec est propre |
| P2 | Tick DMX 16 univers à 44 Hz | ✅ **validé** | Aucune trame perdue ; **déclenchement → paquet 3,9 ms au pire avec le rendu immédiat**, contre 23 ms sans |
| P3 | Rack `.adg` cloné depuis la coquille | 🟡 **à ouvrir dans Live** | Rack de 6 chaînes depuis la vraie coquille ; tout le reste identique octet pour octet |
| P4 | Clock et SPP depuis Ableton | ⏳ **à faire sur le Mac** | Suivi testé en unitaire (±0,5 BPM avec une gigue de ±1 ms, position par SPP) |
| P5 | Aftertouch dans un clip | ⏳ **à faire sur le Mac** | Le parseur gère l'aftertouch poly et canal |
| P6 | Découverte Art-Net | 🟡 **à refaire sur le réseau lumière** | Validé contre un faux node |
| P7 | **RTP-MIDI en pur Node** (sans démon) | ✅ **validé en local**, 🟡 interop Mac à tester | Invitation, synchro d'horloge, MIDI dans les deux sens ; aller-retour p50 0,06 ms |
| P8 | **Génération de Live Set** | 🟡 **à ouvrir dans Live** | Repères, clips autonomes, tempo ; XML bien formé ; autres pistes intactes |
| P9 | **Flux WebSocket** 16 univers vers N écrans | ✅ **validé** | 8 clients à 25 Hz : 3 % d'un cœur, latence p99 < 1,2 ms ; client lent isolé |
| P10 | **sACN** (E1.31) multicast | ✅ **validé** (local et vraie interface) | 16 univers, aucune perte |
| P11 | **OSC** (pilotage, `/light/help`) | ✅ **validé** | Aller-retour p50 0,06 ms ; table d'adresses renvoyée |
| P12 | **Import `.qxw` et reconnaissance des techniques** | ✅ **validé** sur un vrai workspace | **97 % des techniques reconnues (29/30), 100 % du punch** ; analyse en 150 à 250 ms |

## P2 — tick DMX
16 univers × 512 canaux, rendu simulé, encodage ArtDmx, envoi UDP en local.

| Mesure (30 s) | Tick seul | Tick + rendu immédiat (`requestFrame`) |
|---|---|---|
| Coût d'une trame (16 univers) | moy. 0,82 · max 1,97 ms | moy. 0,74 · max 1,54 ms |
| Trames perdues | **0** | **0** |
| **Déclenchement → paquet reçu** | moy. 12,2 · p99 22,7 · **max 23,1 ms** ❌ | moy. 2,4 · p99 3,8 · **max 3,9 ms** ✅ |

**Décision** : toute commande qui change l'état appelle `requestFrame()` (rendu immédiat, espacement minimal de 4 ms). C'est implémenté dans `src/plugins/light/engine/ticker.ts`. Le node Art-Net ajoute ensuite son propre rafraîchissement DMX, hors de notre contrôle.

## P7 — RTP-MIDI en pur Node
- Le paquet npm `rtpmidi` est **écarté** : abandonné depuis 2019, avec des modules mDNS natifs anciens et une dépendance tirée de GitHub.
- On a donc **notre propre implémentation** d'AppleMIDI (`src/plugins/light/midi/rtp/`) : invitations IN/OK/NO/BY sur les ports de contrôle et de données, synchro CK, charge RTP-MIDI (en-tête court ou long, running status, delta-times).
- **Boucle locale, 2000 notes** : aller-retour p50 0,059 · p99 0,200 · max 1,0 ms.
- Cela supprime le besoin de rtpmidid sous Linux, de Docker ou du Pi : **un seul chemin de code**.
- **Pas encore fait** : annonce Bonjour (on ajoute l'hôte par IP dans la fenêtre « Réseau » du Mac), journal de récupération, retours RS.
- **À tester sur le Mac** : `npm run proto:rtp -- --listen`, puis connexion depuis Configuration audio et MIDI.

## P8 — Live Set
- On clone le clip dessiné à la main sur la piste visée. Les clips sont **autonomes** (`LoopEnd` = leur longueur, `StartRelative` = 0) et les **`TakeId` sont uniques** à partir de 1000. Ce sont les deux causes de plantage de Live relevées dans le retour d'expérience.
- Repères (chant puis STOP), paliers de tempo, pistes trouvées par leur nom, autres pistes identiques octet pour octet.
- Sur une copie du Live Set de démonstration de l'utilisateur : 6 repères, 9 clips, 6 points de tempo, XML bien formé.
- **À vérifier dans Live** : ouverture sans plantage, repères, clips, notes, tempo.
- À voir aussi : l'automation de tempo d'origine commence souvent par un point à `-63072000` (valeur avant le début du morceau), que le remplacement supprime, comme le faisait déjà le script de l'utilisateur.
- **Reste à faire** : le mode hybride (conserver les éléments posés à la main), à la reprise du prototype en module.

## P9 — flux WebSocket
- Enveloppe et codec msgpack repris de wing. Une trame fait 16 univers × 512 octets ≈ 8,3 Kio.

| Essai | Résultat |
|---|---|
| 8 clients à 25 Hz pendant 10 s | 24,9 trames/s chacun, latence p50 0,4 · p99 < 1,2 ms ; débit total 1,6 Mio/s ; **3,1 % d'un cœur** (serveur et clients) |
| 1 client qui ne lit plus, pendant 40 s | une fois les tampons TCP pleins, ses trames sont **sautées** (612), les autres clients ne sont **pas affectés**, la mémoire reste bornée |

**Décision** : sur le canal stream, un client au-delà de 256 Kio en attente est sauté (la trame suivante remplace la précédente).

## P10 — sACN
16 univers en multicast à 44 Hz, reçus en process. Sur loopback, 226 paquets par univers, aucune perte. Sur l'interface réseau réelle, 135 paquets par univers, aucune perte.

## P11 — OSC
Codec maison (i, f, s, T, F, N, bundles) et routes à paramètres (`/light/group/{id}/level`). 2000 messages en aller-retour : p50 0,059 · p99 0,129 ms. `/light/help` renvoie une réponse par adresse.

## P12 — import QLC+ et reconnaissance
- **Import** :
  - `.qxf` : canaux, couleurs, tags de capabilities, têtes = cellules ;
  - `.qxw` : fixtures, fonctions, pas, console virtuelle, cadres solo, entrées MIDI décodées.
- **Pièges réels rencontrés** :
  - les noms de modes diffèrent entre versions de QLC+ (« 39-channel » contre « 39 Channel »), d'où une comparaison tolérante ;
  - **QLC+ retire les valeurs nulles des pas** à la sauvegarde : dans une séquence, une valeur absente compte pour 0 (éteint).
- **Reconnaissance des techniques** : classe de teinte par cellule (24 teintes, blanc, éteint), puis règles :
  - creux = une fenêtre éteinte circulaire de largeur constante qui se déplace ;
  - masques ON/OFF = chaque cellule allumée garde sa couleur, sinon masques colorés ;
  - palette qui tourne = décalage de teinte cohérent en cycle d'au moins 3 couleurs (vote majoritaire, accents ignorés) ;
  - damier = deux teintes qui s'échangent ;
  - respiration et plat.
- **Évaluation sur un vrai workspace** (30 sections étiquetées par l'utilisateur lui-même, étiquettes gardées hors dépôt) :

  | Itération | Techniques reconnues |
  |---|---|
  | 1re version | 63 % |
  | Zéros omis traités comme éteints | 77 % |
  | Creux, damier avec accent, masques ON/OFF | 90 % |
  | Décalage de palette tolérant | **97 % (29/30)** |
  | « Punch » (attaque claque ou respire) | **100 % (30/30)** |

  Le seul échec est une section de masques colorés sans aucun bloc noir, reconnue comme une palette.
- **Second workspace** (31 fixtures) : la plupart des définitions de fixtures ne sont pas dans le dépôt public de QLC+ (définitions personnelles). **Il faudra les fichiers `.qxf` de l'utilisateur**, situés dans la bibliothèque QLC+ du Mac.
- Les palettes sont extraites par classe de teinte (la couleur la plus franche), par exemple « ambre ↔ or » utilisée 3 fois.

## Points à retenir
- **Linux** : `snd-seq` est requis pour le MIDI local ; le RTP-MIDI n'a plus besoin de rtpmidid (P7).
- **macOS** : les sessions RTP-MIDI du système apparaissent aussi comme ports CoreMIDI. Les deux voies restent possibles.
- **Port 6454** : il ne peut pas être partagé avec QLC+ sur la même machine. Pendant la transition, un seul des deux émet.
- **npm 12** : il faut approuver les scripts d'installation d'esbuild et de `@julusian/midi`.
