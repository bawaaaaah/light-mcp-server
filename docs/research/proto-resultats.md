# Résultats des prototypes (étape 0)

Mode d'emploi : [prototypes/README.md](../../prototypes/README.md). Sauf mention contraire, les mesures datent du 2026-10-13, sur la machine de dev (Linux x86_64, Node 26). **Premiers résultats sur le Mac de régie : 2026-10-14** (colonne « En une ligne »).

**Restent à faire sur le Mac** : P3/P8 (rack et Live Set ouverts dans Live) ; P6 et la bascule QLC+ sur le réseau lumière ; le hotplug USB ; le regard de la scène réelle ([tests-mac](../tests-mac.md)). **Fait (2026-10-14)** : P1 (bus IAC), P4/P5 (Ableton sur le bus IAC), P12 + auto-test du vrai show.

## Synthèse
| # | Sujet | État | En une ligne |
|---|---|---|---|
| P1 | MIDI local (IAC, USB) depuis Node, hotplug, latence | ✅ **validé sur le Mac (bus IAC)** ; 🟡 hotplug | Bus IAC détecté et utilisé comme boucle : latence 500/500, **p95 0,19 ms, max 0,26 ms** (< 2 ms) ; hotplug USB pas encore testé (nécessite de brancher/débrancher) |
| P2 | Tick DMX 16 univers à 44 Hz | ✅ **validé** (Linux et Mac) | Aucune trame perdue ; déclenchement → paquet **3,9 ms (Linux), 4,97 ms (Mac)** au pire avec le rendu immédiat, contre 23 ms sans |
| P3 | Rack `.adg` cloné depuis la coquille | ✅ **validé sur le Mac, charge dans Live** | Rack de 6 chaînes généré depuis **une vraie coquille de Live** (un branch réel, notes 36/37/38/39/60/61) ; chargé sans erreur dans Live 12.4.5. Coquille synthétique `shell-rack.xml` écartée (Live la rejetait, scaffold incomplet) |
| P4 | Clock et SPP depuis Ableton | ✅ **validé sur le Mac (bus IAC)** | Lecture en boucle : tempo suivi (103→162 BPM, gigue ±0,05), position qui avance (mesure 1.1→1139), transport arrêt↔lecture, sauts gérés |
| P5 | Aftertouch dans un clip | ✅ **validé sur le Mac** | Enveloppe `chanAT` bien reçue entre `noteOn` et `noteOff` : crête 103 puis décroissance 92/77/58/42/30/19 (fondu/punch d'un clip) |
| P6 | Découverte Art-Net | 🟡 **à refaire sur le réseau lumière** | Validé contre un faux node ; sur le Mac hors réseau lumière : 0 node en 5 s (attendu) |
| P7 | **RTP-MIDI en pur Node** (sans démon) | ✅ **validé** (Linux et Mac, boucle locale), 🟡 connexion depuis « Configuration audio et MIDI » à tester | Aller-retour p50 0,06 ms (Linux) ; **Mac, 1000 notes : p50 0,037 · p95 0,077 · p99 0,096 · max 0,32 ms** |
| P8 | **Génération de Live Set** | 🟡 **à ouvrir dans Live** | Repères, clips autonomes, tempo ; XML bien formé ; autres pistes intactes |
| P9 | **Flux WebSocket** 16 univers vers N écrans | ✅ **validé** (Linux et Mac) | 8 clients à 25 Hz : ~3 % d'un cœur, latence p99 < 1,2 ms ; client lent isolé (Mac : 113 trames sautées pour lui seul, les autres intacts) |
| P10 | **sACN** (E1.31) multicast | ✅ **validé** (Linux et Mac) | 16 univers, aucune perte (Mac : 217 paquets par univers, 0 trou) |
| P11 | **OSC** (pilotage, `/light/help`) | ✅ **validé** (Linux et Mac) | Aller-retour p50 0,06 ms (Linux), 0,035 ms (Mac) ; table d'adresses renvoyée |
| P12 | **Import `.qxw` et reconnaissance des techniques** | ✅ **validé** sur un vrai workspace (Mac, `.qxf` de la bibliothèque QLC+) | **Import réel réussi** : 31 fixtures, 108 séquences, 0 collision ; **auto-test 92/92 mappings, latence max 3,46 ms, exclusivité OK, cadence 100 % ✔** ; 4 modèles sans `.qxf` (notés) |

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
- **Second workspace** (31 fixtures) : la plupart des définitions de fixtures ne sont pas dans le dépôt public de QLC+ (définitions personnelles). Les `.qxf` ont été fournis par l'utilisateur (bibliothèque QLC+ du Mac, 634 fichiers) et placés dans `data/fixtures/` (exclu de git).
- Les palettes sont extraites par classe de teinte (la couleur la plus franche), par exemple « ambre ↔ or » utilisée 3 fois.

## P12 + §6 — import réel et auto-test du vrai show (Mac de régie, 2026-10-14)
Le vrai workspace (QLC+ 4.14.4, 31 fixtures, 108 séquences) a été importé puis testé en mode `--offline` (données dans `data/`, exclu de git), sans serveur en réseau :
| Étape | Résultat |
|---|---|
| Import (proposition) | 31 fixtures patchées, canevas 101 cellules, 106 looks, 13 groupes (1 exclusif), 92 mappings MIDI |
| Import `--apply` | **0 collision** |
| **Auto-test (mappings / exclusivité / latence)** | **92/92 mappings · 0 échec · latence 0,16 p50 / 3,46 ms max** · 1 règle d'exclusivité « une seule scène à la fois » ✔ |
| **Auto-test en cadence (temps réel, 120 BPM)** | 104 lignes, **toutes ✔** : 35 cadences mesurées (ex. 500,3/500 ms ; 100,1/100 ms) et 69 ignorées (fondus d'attaque sur plus d'un demi-pas, non mesurables par changement — comportement attendu) |
| Définitions manquantes | 4 modèles sans `.qxf` dans la bibliothèque QLC+ (anonymisés) : un PAR « tri flat RGB », un générique 1 canal (poursuite), une machine à fumée 8 canaux, un PAR 9 canaux ; ils sont patchés sans décodage (signalé par l'avertissement « patchée sans décodage ») |

Le seul bémol attendu : des **faders QLC+ à plusieurs canaux** (blanc/UV/effets/strobos, ~11 faders) dont les canaux hors gradateur ne sont pas convertis automatiquement en looks ni en règles — à refaire à la main, comme prévu par la spec d'import.

## P4 + P5 — horloge, position et aftertouch depuis Ableton (Mac, bus IAC, 2026-10-14)
`npm run proto:midi -- --in "QLC+ loop"` en écoute directe du bus IAC pendant que Live tournait en boucle :
- **Horloge/tempo (P4)** : le BPM est suivi en continu, **103,00 → 162,00 BPM** (plusieurs temps de lecture à des tempos différents), gigue de **±0,05 BPM** (critère ±0,5, largement respecté). Le transport bascule **arrêt ↔ lecture** et est signalé comme tel.
- **Position SPP (P4)** : la position avance en mesure.temps, de **1.1** jusqu'à **mesure 1139.2** sur la session, soit un défilement cohérent de la grille.
- **Aftertouch (P5)** : un clip avec enveloppe de pression émet bien des `chanAT` **entre `noteOn` et `noteOff`**. Extrait : `noteOn n22 → p0 → p103 (crête) → 92 → 77 → 58 → 42 → 30 → 19 → 18`, puis remontée `27 → 33 → 51 → 69 → 91 → 106` — un vrai fondu/punch, pas un message isolé. Le parseur distingue `chanAT` (reçu, 113 occurrences) de `polyAT` (non utilisé ici, ce qui est normal pour une enveloppe de modulation commune à un canal).
- **Note d'usage** : c'est Live qui **sort** l'aftertouch du clip (l'éditeur de clips en émet bien en MIDI out), contrairement à beaucoup de DAW ; le mode « Momentané » de suivi de look peut donc réellement suivre la dynamique.

## Points à retenir
- **Linux** : `snd-seq` est requis pour le MIDI local ; le RTP-MIDI n'a plus besoin de rtpmidid (P7).
- **macOS** : un **bus IAC** sert de boucle MIDI de bout en bout sans matériel (latence P1 mesurée dessus). Les sessions RTP-MIDI du système apparaissent aussi comme ports CoreMIDI. Les deux voies restent possibles.
- **Port 6454** : il ne peut pas être partagé avec QLC+ sur la même machine. Pendant la transition, un seul des deux émet.
- **Un seul `.qxf` manquant bloque le décodage d'un fixture** (il reste patché sans décodage) ; l'import signale chaque modèle et chaque fader qui demande un travail manuel.
- **npm 12** : il faut approuver les scripts d'installation d'esbuild et de `@julusian/midi`.
