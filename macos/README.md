# App de barre de menus Light MCP (macOS)

Une petite app de barre de menus qui lance le serveur de ce dépôt et le garde en marche. Elle n'a pas
d'icône dans le Dock. Elle reprend celle de [wing-mcp-server](https://github.com/bawaaaaah/wing-mcp-server)
(`macos/WingMenuBar`). Son menu permet de :

- **Démarrer / Arrêter** le serveur (`node dist/cli/main.js serve` dans le dépôt, comme `npm start`,
  avec ses données dans `data/`) ;
- le **Redémarrer** ;
- **Recompiler et redémarrer** : lance `npm run build`. Le serveur en marche continue de servir pendant
  la compilation et ne redémarre que si elle réussit. Sinon, une alerte montre la fin de la sortie ;
- **Ouvrir l'interface** (`http://127.0.0.1:<port>`) et **Ouvrir l'adresse publique** (`server.publicUrl`
  de `data/machine/config.json`, seulement si elle est définie). Les deux liens portent le jeton
  d'authentification (`#token=…`, lu dans `server.authToken`) : l'interface s'ouvre déjà connectée en
  administrateur. Le jeton reste dans le navigateur, il n'est jamais envoyé au serveur dans l'adresse ;
- **Afficher les journaux** : ouvre `data/prod.log` dans Console. La sortie du serveur, celle de la
  compilation et les lignes `[menubar]` de l'app y vont toutes ;
- **Lancer le serveur à l'ouverture de l'app** (activé par défaut) et **Ouvrir à la connexion**.

L'icône est un projecteur. Elle est grisée quand le serveur est arrêté, tourne pendant un démarrage, un
arrêt ou une compilation, et devient un triangle d'alerte quand `/health` ne répond pas `HEALTHY`
(par exemple « dégradé » : la découverte Art-Net n'a pas pu prendre le port 6454, souvent parce que
QLC+ tourne sur le même Mac) ou après un plantage.

Le serveur est un enfant de l'app : **quitter l'app arrête le serveur**. S'il s'arrête tout seul, l'app
le relance après 1, 2, 5 puis 10 s. Après 5 arrêts en une minute, elle abandonne et affiche *Planté*.

Si autre chose répond déjà à `/health` sur le port (par exemple un serveur lancé à la main avec
`npm run serve`), le menu affiche *En marche (lancé à part)* et désactive Démarrer, Arrêter et
Redémarrer. L'app n'envoie jamais de signal à un processus qu'elle n'a pas lancé.

L'app ne touche pas à la sortie : le serveur démarre en veille ou en émission selon la config, comme
avec `npm start` (voir [bascule-qlc.md](../docs/bascule-qlc.md)).

## Compiler et installer

Il faut les Command Line Tools de Xcode (Swift 6) et `node` dans le `PATH` :

```bash
macos/build-app.sh
```

Le script compile `macos/build/LightMCP.app`, le signe localement (ad hoc) et le copie dans
`~/Applications/LightMCP.app`. Si l'app tournait déjà, le script la relance, et la nouvelle copie
reprend le serveur déjà en marche (grâce à `data/menubar.pid`) au lieu de le redémarrer.

Le script ne compile pas le serveur : faire `npm run build` une première fois (voir
[install.md](../docs/install.md)), ou utiliser *Recompiler et redémarrer* depuis le menu. Si
`dist/cli/main.js` manque, *Démarrer* compile d'abord.

Au premier démarrage du serveur, macOS demande si **LightMCP** peut trouver des appareils sur le réseau
local. Il faut accepter, sinon le serveur ne peut ni découvrir ni piloter les nodes Art-Net et sACN. Si
la question est passée, le réglage est dans Réglages Système › Confidentialité et sécurité › Réseau
local.

Activer **Ouvrir à la connexion** pour lancer l'app (et donc le serveur) à l'ouverture de la session.
Si macOS demande une autorisation, l'élément affiche un tiret et ouvre Réglages Système › Général ›
Ouverture.

## Réglages

Le port et l'interface d'écoute se règlent dans `data/machine/config.json` (`server.port`,
`server.host`, voir [install.md](../docs/install.md#port-et-interface-réseau)) : l'app lit le même
fichier pour sa surveillance et ses liens. Un port réglé par `defaults` passe avant celui du fichier.

La compilation inscrit le chemin du dépôt et le `node` trouvé. Pour les changer, ou imposer un port,
utiliser `defaults`, puis quitter et rouvrir l'app :

```bash
defaults write com.bawaaaaah.light-mcp-menubar port -int 8790
defaults write com.bawaaaaah.light-mcp-menubar nodePath /opt/homebrew/bin/node
defaults write com.bawaaaaah.light-mcp-menubar repoPath ~/light-mcp-server
```

`defaults delete com.bawaaaaah.light-mcp-menubar <clé>` revient à la valeur inscrite à la compilation.
Le serveur lui-même se règle comme d'habitude, dans `data/machine/config.json` et depuis la page
Réglages de l'interface.

## RTP-MIDI sur le Mac

La session réseau MIDI de macOS (Configuration audio et MIDI › Réseau) occupe souvent le port UDP 5004,
celui de la session RTP-MIDI intégrée au serveur. Dans ce cas, le serveur démarre quand même, sans
RTP-MIDI, et le signale dans ses journaux, dans `/health` et sur la page MIDI. Sur le Mac de régie, le
MIDI local (IAC, USB, sessions réseau du Mac) suffit. Pour garder la session intégrée, lui donner un
autre port dans le profil MIDI.
