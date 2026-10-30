# App de la zone de notification Light MCP (Windows)

Une petite app de la zone de notification (près de l'horloge) qui lance le serveur de ce dépôt et le garde
en marche. Elle n'a pas de fenêtre. C'est l'équivalent de l'app de barre de menus du Mac
([`macos/README.md`](../macos/README.md)). Son menu (clic droit sur l'icône) permet de :

- **Démarrer / Arrêter** le serveur (`node dist/cli/main.js serve` dans le dépôt, comme `npm start`,
  avec ses données dans `data/`) ;
- le **Redémarrer** ;
- **Recompiler et redémarrer** : lance `npm run build`. Le serveur en marche continue de servir pendant
  la compilation et ne redémarre que si elle réussit. Sinon, une alerte montre la fin de la sortie ;
- **Ouvrir l'interface** (`http://127.0.0.1:<port>`, aussi par un double-clic sur l'icône) et **Ouvrir
  l'adresse publique** (`server.publicUrl` de `data/machine/config.json`, seulement si elle est définie).
  Les deux liens portent le jeton d'authentification (`#token=…`, lu dans `server.authToken`) :
  l'interface s'ouvre déjà connectée en administrateur. Le jeton reste dans le navigateur, il n'est jamais
  envoyé au serveur dans l'adresse ;
- **Afficher les journaux** : suit `data/prod.log` dans une fenêtre PowerShell. La sortie du serveur, celle
  de la compilation et les lignes `[menubar]` de l'app y vont toutes ;
- **Lancer le serveur à l'ouverture de l'app** (activé par défaut) et **Ouvrir à la connexion** (lancement
  à l'ouverture de la session Windows).

L'icône est un projecteur. Elle est grisée quand le serveur est arrêté, montre deux flèches pendant un
démarrage, un arrêt ou une compilation, et devient un triangle d'alerte quand `/health` ne répond pas
`HEALTHY` (par exemple « dégradé » : la découverte Art-Net n'a pas pu prendre le port 6454, souvent parce
que QLC+ tourne sur le même PC) ou après un plantage. Elle est claire sur une barre des tâches sombre et
foncée sur une barre claire.

Le serveur est un enfant de l'app : **quitter l'app arrête le serveur**, tout comme fermer la session
Windows. Windows n'ayant pas de SIGTERM, l'app demande l'arrêt en fermant l'entrée standard du serveur
(lancé avec `LIGHT_STOP_ON_STDIN_CLOSE=1`) : il sauve l'état en direct et s'arrête, et il est tué s'il
tourne encore 5 s plus tard. Si l'app elle-même plante, le serveur s'arrête proprement de la même façon :
contrairement au Mac, il ne lui survit jamais. S'il s'arrête tout seul, l'app le relance après 1, 2, 5
puis 10 s. Après 5 arrêts en une minute, elle abandonne et affiche *Planté*.

Si autre chose répond déjà à `/health` sur le port (par exemple un serveur lancé à la main avec
`npm run serve`), le menu affiche *En marche (lancé à part)* et désactive Démarrer, Arrêter et
Redémarrer. L'app n'envoie jamais de signal à un processus qu'elle n'a pas lancé. Une seule copie de
l'app tourne par session : la seconde prévient et se ferme.

L'app ne touche pas à la sortie : le serveur démarre en veille ou en émission selon la config, comme
avec `npm start` (voir [bascule-qlc.md](../docs/bascule-qlc.md)).

## Compiler et installer

Il faut le .NET Framework 4.x (présent sur Windows 10 et 11 : le script utilise son compilateur `csc.exe`,
sans SDK à installer) et `node` dans le `PATH`. Windows bloque les scripts PowerShell par défaut, d'où
le `-ExecutionPolicy Bypass` :

```powershell
powershell -ExecutionPolicy Bypass -File windows\build-app.ps1
```

Le script compile `windows\build\LightMCP\LightMCPMenuBar.exe`, le copie dans `%LOCALAPPDATA%\LightMCP`
et écrit à côté `appsettings.json` avec le chemin du dépôt et du `node` trouvé. Si l'app tournait déjà, le
script la ferme (le serveur s'arrête proprement), attend la fin du serveur, puis lance la nouvelle copie,
qui redémarre le serveur.

`-NoInstall` compile seulement. L'exe ainsi produit, comme celui de la CI (artefact `windows-menubar`),
n'a pas d'`appsettings.json` : lancé depuis `windows\build\LightMCP\` ou tout autre dossier du dépôt, il
trouve le dépôt autour de lui ; ailleurs, il faut lui donner `repoPath` (voir Réglages). Sans dépôt, le
menu affiche *Dépôt introuvable*.

Le script ne compile pas le serveur : faire `npm run build` une première fois (voir
[install.md](../docs/install.md)), ou utiliser *Recompiler et redémarrer* depuis le menu. Si
`dist/cli/main.js` manque, *Démarrer* compile d'abord.

Au premier démarrage du serveur, le pare-feu Windows demande si **Node.js** peut communiquer sur le
réseau. Il faut l'autoriser sur les réseaux privés, sinon le serveur ne peut ni découvrir les nodes
Art-Net, ni être joint par les tablettes. Si la question est passée, le réglage est dans Pare-feu
Windows Defender › Autoriser une application via le pare-feu.

## Réglages

Le port et l'interface d'écoute se règlent dans `data/machine/config.json` (`server.port`,
`server.host`, voir [install.md](../docs/install.md#port-et-interface-réseau)) : l'app lit le même
fichier pour sa surveillance et ses liens. Un port réglé dans le registre passe avant celui du fichier.

Pour changer le chemin du dépôt ou de `node`, ou imposer un port, écrire sous
`HKCU\Software\LightMCPMenuBar`, puis quitter et rouvrir l'app :

```powershell
reg add HKCU\Software\LightMCPMenuBar /v port /t REG_DWORD /d 8790 /f
reg add HKCU\Software\LightMCPMenuBar /v nodePath /t REG_SZ /d "C:\Program Files\nodejs\node.exe" /f
reg add HKCU\Software\LightMCPMenuBar /v repoPath /t REG_SZ /d "C:\chemin\light-mcp-server" /f
```

`reg delete HKCU\Software\LightMCPMenuBar /v <clé> /f` revient à la valeur de `appsettings.json`. Le
serveur lui-même se règle comme d'habitude, dans `data/machine/config.json` et depuis la page Réglages
de l'interface.

## RTP-MIDI sur Windows

Le pilote rtpMIDI occupe souvent le port UDP 5004, celui de la session RTP-MIDI intégrée au serveur.
Dans ce cas, le serveur démarre quand même, sans RTP-MIDI, et le signale dans ses journaux, dans
`/health` et sur la page MIDI. Pour garder la session intégrée, lui donner un autre port dans le profil
MIDI.
