# Résultats des prototypes (étape 0)

Mode d'emploi : [prototypes/README.md](../../prototypes/README.md). Chaque ligne indique où et quand la mesure a été faite.

## Synthèse
| # | Sujet | État | Résultat |
|---|---|---|---|
| P1 | MIDI depuis Node (IAC, USB, RTP), hotplug, latence | ⏳ **à faire sur le Mac** | Le module natif `@julusian/midi` est livré précompilé pour macOS (x64 et arm64), Linux (x64, arm, arm64) et Windows. Sans séquenceur ALSA, l'ouverture échoue proprement : le serveur devra démarrer sans MIDI local et le signaler |
| P2 | Tick DMX 16 univers à 44 Hz | ✅ **validé** (machine de dev Linux) | Voir plus bas : budget MIDI → paquet tenu **grâce au rendu immédiat** |
| P3 | Rack `.adg` cloné | 🟡 **généré, à valider dans Live** | Rack de 6 chaînes construit depuis la coquille réelle (Live 12.4.5) ; tout ce qui est hors des chaînes est identique octet pour octet |
| P4 | Clock et SPP depuis Ableton | ⏳ **à faire sur le Mac** | Le suivi est testé en unitaire : ±0,5 BPM avec une gigue de ±1 ms, changement de tempo suivi en un temps, position par Start, ticks et SPP |
| P5 | Aftertouch dans un clip | ⏳ **à faire sur le Mac** | — |
| P6 | Découverte Art-Net | 🟡 **validé contre un faux node**, à refaire sur le réseau lumière | ArtPoll et ArtPollReply décodés, sorties et port-addresses déduites ; aucun node sur le réseau de dev (attendu) |

## P2 — tick DMX (2026-10-13, machine de dev Linux x86_64, Node 26)
16 univers × 512 canaux, rendu simulé (sinus sur chaque canal), encodage ArtDmx, envoi UDP en local, 10 s.

| Mesure | Tick seul | Tick + rendu immédiat (`requestFrame`) |
|---|---|---|
| Trames émises | 44,1/s | 58,3/s (les ticks plus les rendus déclenchés) |
| Intervalle de tick (cible 22,73 ms) | p50 22,76 · p99 23,84 · max 24,09 ms | — (un tick est sauté s'il tombe juste après un rendu immédiat) |
| Coût d'une trame (rendu, encodage, envoi de 16 univers) | moy. 0,34 · max 1,68 ms | moy. 0,32 · max 0,49 ms |
| Trames perdues (trous de séquence) | **0** | **0** |
| **Déclenchement → paquet reçu** | moy. 11,3 · p95 21,6 · **max 22,7 ms** ❌ | moy. 1,6 · p95 2,0 · **max 3,5 ms** ✅ |

**Conclusions**
- Le moteur à 44 Hz sur 16 univers ne coûte presque rien (< 2 % d'un cœur), avec une gigue d'environ ±1 ms.
- **Au rythme du tick seul, le budget MIDI → DMX < 10 ms n'est pas tenu** : un déclenchement attend jusqu'à une période entière.
- **Décision technique** : toute commande qui change l'état appelle `requestFrame()`. Le moteur rend alors une trame immédiatement, avec un espacement minimal de 4 ms. C'est implémenté dans `src/plugins/light/engine/ticker.ts`.
- Il reste à mesurer sur le Mac, et en sortie vers un vrai node. Le node lui-même ajoute sa propre latence de rafraîchissement DMX (jusqu'à environ 23 ms), hors de notre contrôle.

## P3 — rack `.adg` (2026-10-13)
- La coquille réelle de l'utilisateur est stockée dans `data/private/`, hors git.
- Le rack de démonstration généré (`prototypes/out/test-rack.adg`) a 6 chaînes, avec des notes de 36 à 61 et le rouge pour Flash et Blackout.
- **À vérifier dans Live** :
  - le rack s'ouvre ;
  - les noms de chaînes sont bons ;
  - les key zones portent sur une seule touche ;
  - les couleurs sont bonnes ;
  - une note de clip allume la bonne chaîne.

## P6 — Art-Net (2026-10-13)
- Contre le faux node (127.0.0.2) : node trouvé, sorties 0 et 1 correctement déduites.
- Sur le réseau de dev : 0 node, ce qui est attendu.
- **À refaire sur le réseau lumière**, avec QLC+ fermé puisqu'il occupe le port 6454.

## Points à retenir pour la suite
- **Linux** : il faut le module `snd-seq` pour le MIDI local, et le démon **rtpmidid** pour le RTP-MIDI (il expose les sessions comme des ports ALSA, donc un seul chemin de code).
- **macOS** : les sessions RTP-MIDI apparaissent comme des ports CoreMIDI, donc un seul chemin de code aussi.
- **Port 6454** : il ne peut pas être partagé avec QLC+ sur la même machine. Pendant la transition avec QLC+ en secours, un seul des deux émet.
