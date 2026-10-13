# Prototypes — étape 0

Scripts jetables qui valident les paris techniques avant le développement ([docs/roadmap.md](../docs/roadmap.md)). Ils s'appuient sur les **vrais modules** de `src/`, pas sur du code à part. Les résultats vont dans [docs/research/proto-resultats.md](../docs/research/proto-resultats.md).

Installation (une fois) :
```bash
npm install
npm install-scripts approve esbuild @julusian/midi && npm rebuild esbuild @julusian/midi
```

| # | Script | Où le lancer | Commande |
|---|---|---|---|
| P1 | MIDI : ports, hotplug, latence | **Mac de régie** (et Linux avec `snd-seq`) | `npm run proto:midi -- --list` · `-- --watch` · `-- --latency --out "IAC" --in "IAC"` |
| P2 | Tick DMX 16 univers | n'importe où | `npm run proto:tick -- --universes 16 --seconds 30` |
| P3 | Rack `.adg` depuis la coquille | n'importe où, **validation dans Live** | `npm run proto:adg -- --shell <coquille.adg>` |
| P4 | Clock et SPP depuis Ableton | **Mac**, Live en lecture | `npm run proto:midi -- --in "IAC"` |
| P5 | Aftertouch dans un clip | **Mac**, clip avec pression | `npm run proto:midi -- --in "IAC"` |
| P6 | Découverte Art-Net | **sur le réseau lumière** (QLC+ fermé) | `npm run proto:artnet -- --seconds 5` |
| P7 | RTP-MIDI pur Node | local, puis **avec le Mac** | `npm run proto:rtp -- --bench` · `-- --listen` |
| P8 | Live Set (`.als`) | n'importe où, **validation dans Live** | `npm run proto:liveset -- --als <set.als> --track "<piste>"` |
| P9 | Flux WebSocket | n'importe où | `npm run proto:ws -- --clients 8 --slow 1` |
| P10 | sACN multicast | n'importe où | `npm run proto:sacn -- --interface <ip>` |
| P11 | OSC | n'importe où | `npm run proto:osc -- --bench` · `-- --listen` |
| P12 | Import `.qxw` | n'importe où | `npm run proto:qxw -- --qxw <fichier> --fixtures <dossier .qxf> [--details]` |
| — | Faux node Art-Net | local | `npm run proto:fake-node -- --bind 127.0.0.2` |

## Sur le Mac de régie (P1, P4, P5)
1. Live → Préférences → Link · Tempo · MIDI : sur la sortie du bus IAC, activer **Sync** (pour P4) et **Track**.
2. `npm run proto:midi -- --list` : noter le nom exact du bus IAC.
3. **P1 latence** : `npm run proto:midi -- --latency --out "IAC" --in "IAC"`. Le bus IAC renvoie ce qu'il reçoit.
4. **P1 RTP-MIDI** : créer une session dans Configuration audio et MIDI → Réseau, puis la retrouver dans `--list` et refaire `--latency` à travers elle.
5. **P1 hotplug** : `npm run proto:midi -- --watch`, puis brancher et débrancher un contrôleur USB et activer et désactiver la session réseau.
6. **P4** : `npm run proto:midi -- --in "IAC"`, puis lancer la lecture dans Live, changer le tempo et sauter dans l'arrangement. Vérifier le BPM affiché (±0,5) et la position (mesure.temps) après le saut.
7. **P5** : jouer un clip qui contient de l'aftertouch (enveloppe de pression dans le clip). Des lignes `polyAT` ou `chanAT` doivent apparaître entre la note on et la note off.

8. **P7 avec le Mac** : sur la machine qui fait tourner le prototype, `npm run proto:rtp -- --listen`. Sur le Mac : Configuration audio et MIDI → Fenêtre → Configuration du réseau MIDI → Annuaire « + », saisir l'IP et le port 5004, puis Connecter. Router une piste de Live vers cette session et jouer quelques notes, avec Sync activé pour l'horloge.
9. **P3 et P8 dans Live** : ouvrir `prototypes/out/test-rack.adg` et `prototypes/out/test-set.als` (générés depuis tes fichiers, avec Live fermé pendant la génération).
10. **P12** : copier tes `.qxf` personnels (Bibliothèque QLC+ → Fixtures) dans `data/fixtures/` pour décoder tous les appareils.

Noter les résultats (copier la sortie) dans `docs/research/proto-resultats.md`.

## Sur Linux
- MIDI local : `sudo modprobe snd-seq` (et l'ajouter dans `/etc/modules-load.d/` pour le rendre permanent).
- RTP-MIDI : intégré en pur Node (P7), sans démon. En alternative, rtpmidid expose les sessions comme des ports ALSA, visibles par P1.
