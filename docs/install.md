# Installation et premiers pas

## 1. Installer
### Sur le Mac de régie (référence v1)
```bash
git clone <dépôt> light-mcp-server && cd light-mcp-server
npm install
npm install-scripts approve esbuild @julusian/midi && npm rebuild esbuild @julusian/midi   # npm ≥ 12
npm --prefix web install
npm run build
```
Le MIDI local passe par CoreMIDI : bus IAC, contrôleurs USB, et sessions réseau du Mac.

### Sur un serveur distant (Linux, Raspberry Pi, Docker)
```bash
docker compose up -d --build      # réseau hôte, données dans ./data
```
- Le MIDI arrive en **RTP-MIDI** : session intégrée sur le port 5004, à ajouter depuis le Mac (voir § 4).
- Sous Linux sans Docker, le MIDI USB local demande le séquenceur ALSA : `sudo modprobe snd-seq`.

## 2. Démarrer
```bash
npm run light -- pin regisseur 1234     # un PIN par rôle : admin, regisseur, benevole, lecture
npm start                               # ou npm run serve en développement
```
- Interface : `http://<machine>:8790`. On entre avec le **jeton** (`npm run light -- token`) ou, en dessous, avec le **PIN** d'un utilisateur choisi dans la liste. Un administrateur crée dans **Réglages** des **liens de partage** (utilisateur + PIN) qui connectent d'un clic.
- **Sur le Mac, depuis la barre de menus** : `macos/build-app.sh` installe `~/Applications/LightMCP.app`, qui lance le serveur compilé, le relance s'il plante, le recompile, ouvre l'interface et les journaux, et peut s'ouvrir à la connexion (voir [macos/README.md](../macos/README.md)).
- MCP : `http://<machine>:8790/mcp` avec le jeton de `npm run light -- token`, ou en stdio avec `node dist/cli/main.js serve --stdio --no-http`. La page **Connexion IA** de l'interface donne la marche à suivre par client.
- **Pendant la transition avec QLC+** : un seul des deux émet. Lancer le serveur en veille (`npm run serve -- --standby`) et suivre [bascule-qlc.md](bascule-qlc.md) ; sur un Mac partagé avec QLC+, mettre `"discovery": false` (port 6454).
- **En ligne de commande** : `npm run light -- check`, `selftest --cadence`, `pack`, `standby on|off`… (`npm run light -- help`). La CLI passe par le serveur s'il tourne, sinon elle ouvre les données directement.

### Port et interface réseau
Dans `data/machine/config.json`, section `server` (à la main, serveur arrêté ou redémarré ensuite) :

```json
{ "server": { "port": 8790, "host": "0.0.0.0", "publicUrl": "https://lumiere.example.com" } }
```

- `port` : 8790 par défaut. L'option `--port` et la variable `PORT` passent avant le fichier.
- `host` : `0.0.0.0` (défaut) écoute sur toutes les interfaces, donc les tablettes du réseau local ; `127.0.0.1` réserve le serveur à la machine, par exemple derrière un reverse proxy installé dessus. `--host` passe avant.
- `publicUrl` : l'adresse publique derrière un reverse proxy (voir le [README](../README.md#accès-depuis-lextérieur-reverse-proxy)).

## 3. Reprendre un show QLC+
1. Copier les définitions de fixtures (`.qxf`) dans `data/fixtures/` : celles de la bibliothèque QLC+ du Mac et les tiennes.
2. Dans l'interface : **Import**, choisir le `.qxw`, lire la proposition, puis **Appliquer**.
   - Fixtures, canevas, looks (pas exacts), groupes exclusifs, masters et mappings MIDI sont créés, avec les **mêmes notes**.
3. **Reconstruire** : les looks reconnus deviennent des techniques éditables quand le rendu reste fidèle.
4. **Auto-test** : chaque mapping est rejoué, et l'effet, l'exclusivité et la latence sont vérifiés.
5. Dans **Show**, choisir le **look de secours** du Panic neutre. Sans look de secours, le Panic fait un Blackout.

## 4. MIDI et Ableton
- **Local (IAC)** : page **MIDI**, profil `local` (entrées dont le nom contient « IAC »). Dans Live, sur la sortie du bus IAC, activer Sync pour l'horloge.
- **RTP-MIDI** : enregistrer un profil avec `rtp.enabled` à vrai (par l'API `midi.profile.save`), puis le sélectionner. Sur le Mac : Configuration audio et MIDI → Réseau → Annuaire « + » → IP du serveur, port 5004 → Connecter.
- **Retour LED** : choisir une sortie distincte des entrées. Le serveur refuse une sortie qui boucle sur une entrée.
- **Rack Ableton** : déposer la coquille (un MIDI Effect Rack à une chaîne, exporté de ta version de Live) dans `data/private/shell.adg`, puis lancer `export.ableton.rack`. Le rack est écrit dans `data/exports/`.
- **Live Set** : copier ton `.als` dans `data/private/`, Live fermé, puis lancer `export.liveset` (setlist, nom de piste). La copie est écrite dans `data/exports/`.

## 5. Concevoir avec l'IA (MCP)
Exemples de demandes :
- « décris la scène » (ressource `light://stage`) ;
- « crée un look intimité / adoration sur le canevas mur » (`look.from_intent`) ;
- « remplis la grille du chant X » (`song.grid_fill`) ;
- « vérifie le show » (`show.lint`).

Ta base de connaissances couleur personnelle se dépose dans `data/private/knowledge.json`. Elle complète la base générique, mot par mot.

## 6. Données
Tout est dans `data/`, exclu de git :

| Dossier | Contenu |
|---|---|
| `machine/` | configuration, rôles |
| `venues/` | lieux |
| `shows/` | shows |
| `fixtures/` | définitions de fixtures |
| `imports/` | fichiers à importer |
| `private/` | coquilles Ableton, base de connaissances personnelle |
| `exports/` | fichiers générés |
| `backups/` | versions précédentes |

Chaque objet est un fichier JSON lisible, et les sauvegardes conservent automatiquement la version précédente.
