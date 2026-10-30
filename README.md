# light-mcp-server

Contrôleur lumière DMX (Art-Net / sACN) open source. On le pilote depuis une interface web temps réel (WebSocket), en MIDI ou OSC depuis Ableton et les contrôleurs, ou par une IA via MCP.

> **Statut : en développement (v0).** Installation et premiers pas : [`docs/install.md`](docs/install.md) (sources, Docker) ou [`docs/install-npm.md`](docs/install-npm.md) (paquet `@bawaaaaah/light-mcp-server` sur GitHub Packages ; image `ghcr.io/bawaaaaah/light-mcp-server`).
> Sur le Mac de régie, une app de barre de menus lance et surveille le serveur : [`macos/README.md`](macos/README.md). Sur un PC Windows, la même app vit dans la zone de notification : [`windows/README.md`](windows/README.md).
> Reprendre le projet : [`docs/HANDOFF.md`](docs/HANDOFF.md). Feuille de route : [`docs/roadmap.md`](docs/roadmap.md).

## En bref
- Architecture inspirée de [bawaaaaah/wing-mcp-server](https://github.com/bawaaaaah/wing-mcp-server) : Node/TypeScript, un `core/` générique et un plugin `light`, avec **une seule couche de commandes** pour l'UI, le MIDI, l'OSC, le MCP, la timeline et la CLI.
- Sortie **Art-Net 4** avec découverte des nodes, et **sACN**. Jusqu'à 16 univers.
- **Lieu, scène et canevas** : on écrit les effets sur un canevas abstrait, rendu ensuite sur le kit de chaque salle. La scène virtuelle (zones, hauteurs, orientations, rôles) est lisible par l'IA.
- **Techniques à pas** (damier, palette qui tourne, masques, orage…) avec attaque et cadence au BPM, et **effets par forme d'onde**.
- **Groupes** unifiés : sous-groupes, master proportionnel façon DCA, exclusivité, limites.
- **Règles** de sécurité : modes interdits, max UV, zones protégées, scènes sans intensité, politique strobe, Panic neutre et Blackout.
- **MIDI** :
  - entrées locales et RTP-MIDI auto-détectées ;
  - modes Déclencher, Latch et Momentané, registre de notes, retour sur port distinct, MIDI clock et SPP ;
  - export de **MIDI Effect Rack** Ableton et génération de Live Set.
- **Chants et setlist** : grille de conception, boutons et/ou timeline, feuille de conduite, planche.
- **Dashboards** modulables FR/EN : glisser-déposer, redimensionnement par les coins, grille magnétique, couleurs, plein écran, sur ordinateur, tablette et téléphone ; console DMX par projecteur ; éditeurs d'effets, d'easing et de timing ; notes partout.
- **Shows et sauvegardes** comme une console lumière : nouveau, dupliquer, réinitialiser, sauvegarde automatique quotidienne, **versions précédentes** et objets supprimés récupérables ; un objet encore utilisé ne se supprime pas par mégarde.
- **Utilisateurs et rôles** (PIN, clés de sécurité, OAuth pour claude.ai), droits appliqués à l'interface comme au MCP, **journal d'activité** (qui a fait quoi, d'où).
- **Données** en fichiers texte (git) et archives `.lightshow`, **CLI** `light` et **SDK** de scripts, **plugins**.

## Démarrer
```bash
npm run build && npm start        # http://localhost:8790 ; MCP sur /mcp
npm run light -- token            # le jeton d'authentification (jamais écrit dans les journaux)
```
On entre dans l'interface avec ce **jeton**, avec une **clé de sécurité** (YubiKey, passkey ; par `localhost` ou l'adresse publique HTTPS), ou avec le **PIN** d'un utilisateur choisi dans la liste. Les utilisateurs (nom, rôle, PIN, clés) se gèrent dans **Réglages**. Sur le Mac, l'app de barre de menus ouvre l'interface déjà connectée. Le port et l'interface d'écoute se règlent dans `data/machine/config.json` (`server.port`, `server.host`) : voir [install.md](docs/install.md#port-et-interface-réseau).

## Connecter un client MCP
La page **Connexion IA** de l'interface donne l'adresse, le jeton et la marche à suivre pour Claude Code, Claude Desktop, claude.ai, le stdio, MCP Inspector et `curl`. En bref :

### À distance, en HTTP
Le serveur parle MCP en **HTTP streamable** sur `/mcp`, avec le jeton en en-tête `Authorization: Bearer`. Les droits du jeton sont ceux de l'administrateur, et les règles du show s'appliquent à l'IA comme à l'interface.

```bash
claude mcp add --transport http light http://<machine>:8790/mcp \
  --header "Authorization: Bearer VOTRE_JETON"
```

Pour Claude Desktop : Réglages → Connecteurs → Ajouter un connecteur personnalisé, avec l'adresse et l'en-tête. Sans en-têtes dans votre version, passer par `mcp-remote` :

```json
{
  "mcpServers": {
    "light": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://lumiere.example.com/mcp", "--header", "Authorization: Bearer VOTRE_JETON"]
    }
  }
}
```

claude.ai (web) n'accepte que des connecteurs **OAuth**, que le serveur propose dès que `server.publicUrl` est défini (adresse HTTPS, voir plus bas) : Réglages → Connecteurs → Ajouter un connecteur personnalisé, avec l'adresse `https://<votre-domaine>/mcp`, puis autoriser sur la page qui s'ouvre, avec une **clé de sécurité** (YubiKey, passkey) ou le jeton. claude.ai reçoit ses propres jetons, valables sur `/mcp` seulement, avec les droits de qui l'a autorisé ; ils se révoquent depuis la page **Connexion IA**.

### En local, en stdio
Le client lance son propre serveur, sans réseau ni jeton :

```bash
claude mcp add light -- node /chemin/vers/light-mcp-server/dist/cli/main.js serve --stdio --no-http
```

Pas pendant que le serveur HTTP tourne sur les mêmes données : le show aurait deux écrivains.

## Accès depuis l'extérieur (reverse proxy)
Pour un client hors du réseau local (claude.ai, un téléphone, un régisseur à distance), publier le serveur derrière un **reverse proxy HTTPS** sur votre domaine, comme pour wing-mcp-server. Dans `data/machine/config.json` :

```json
{ "server": { "publicUrl": "https://lumiere.example.com", "trustProxy": 1, "host": "127.0.0.1", "port": 8790 } }
```

- `publicUrl` : l'adresse publique. Les liens de partage la reprennent, son origine peut ouvrir le WebSocket, OAuth (claude.ai) et les clés de sécurité s'y activent.
- `trustProxy` : le nombre de proxys devant le serveur (`1` pour un Caddy ou un nginx). Sans lui, toutes les requêtes arrivent avec l'adresse du proxy : la limite des essais de PIN serait commune à tous, et un seul attaquant bloquerait tout le monde. Un nombre, jamais « tout » : sinon un client pourrait inventer son adresse.
- `host` : `127.0.0.1` quand le proxy tourne sur la même machine (seul le proxy joint alors le serveur) ; `0.0.0.0` pour garder aussi le réseau local (tablettes).
- Redémarrer le serveur après la modification.

Avec Caddy (certificat automatique) :

```
lumiere.example.com {
  reverse_proxy 127.0.0.1:8790
}
```

Avec nginx, garder les en-têtes `Upgrade` (WebSocket de l'interface), transmettre l'adresse du client (`X-Forwarded-For`, lu grâce à `trustProxy`), couper la mise en tampon (réponses en flux de MCP) et accepter les gros envois (sauvegardes `.lightshow`, workspaces QLC+) :

```nginx
location / {
  proxy_pass http://127.0.0.1:8790;   # ou l'adresse du Mac de régie sur le réseau local
  proxy_http_version 1.1;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
  proxy_buffering off;
  proxy_read_timeout 1h;
  client_max_body_size 64m;
}
```

Une fois exposé sur Internet :
- le **jeton** donne la main sur toute la lumière : le garder secret. Pour le changer, retirer `server.authToken` du fichier puis redémarrer ;
- préférer les **clés de sécurité** aux PIN pour qui entre par Internet : une clé ne se devine pas ;
- les **PIN** sont limités à 5 essais faux par minute et par adresse (celle du client, avec `trustProxy`) : préférer tout de même des PIN de 8 chiffres ;
- un **lien de partage** (Réglages, utilisateur + PIN) fait entrer avec ce rôle quiconque l'a. Changer le PIN annule le lien ;
- les **clés de sécurité** sont liées à l'adresse : une clé enregistrée par `localhost` ne marche pas par l'adresse publique, et inversement. Enregistrer la clé depuis l'adresse où on s'en servira ;
- un tunnel (`npx tunnelmole 8790`, ngrok, Cloudflare Tunnel) dépanne, mais son adresse change souvent : penser à mettre `publicUrl` à jour (et les clés sont à refaire).
