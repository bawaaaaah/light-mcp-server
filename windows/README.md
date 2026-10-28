# App de barre des taches Light MCP (Windows)

Petite application de barre des taches (system tray) qui lance le serveur de ce depot et le garde en marche.
Elle reprend celle de `macos/LightMenuBar` (Swift). Son menu permet de :

- **Demarrer / Arreter** le serveur (`node dist/cli/main.js serve` dans le depot, comme `npm start`,
  avec ses donnees dans `data/`) ;
- le **Redemarrer** ;
- **Recompiler et redemarrer** : lance `npm run build`. Le serveur en marche continue de servir pendant
  la compilation et ne redemarre que si elle reussit. Sinon, une alerte montre la fin de la sortie ;
- **Ouvrir l'interface** (`http://127.0.0.1:<port>`) et **Ouvrir l'adresse publique** (`server.publicUrl`
  de `data/machine/config.json`, seulement si elle est definie). Les deux liens portent le jeton
  d'authentification (`#token=...`, lu dans `server.authToken`) ;
- **Afficher les journaux** : ouvre `data/prod.log` dans le Bloc-notes ;
- **Lancer le serveur a l'ouverture de l'app** (active par defaut) et **Ouvrir a la connexion** (demarrage automatique Windows).

L'icone est grisee quand le serveur est arrete, et devient un triangle d'alerte quand `/health` ne repond pas
`HEALTHY` ou apres un plantage.

Le serveur est un enfant de l'app : **quitter l'app arrete le serveur**. S'il s'arrete tout seul, l'app le
relance apres 1, 2, 5 puis 10 s. Apres 5 arrets en une minute, elle abandonne et affiche *Plante*.

Si autre chose repond deja a `/health` sur le port (par exemple un serveur lance a la main avec `npm run serve`),
le menu affiche *En marche (lance a part)* et desactive Demarrer, Arreter et Redemarrer.

## Compiler et installer

Il faut .NET Framework 4.x (csc.exe) et `node` dans le `PATH` :

```powershell
windows\build-app.ps1
```

Le script compile `windows/build/LightMCP/LightMCPMenuBar.exe`, l'installe dans `%LOCALAPPDATA%\LightMCP`
et ecrit `appsettings.json` avec le chemin du depot et de node. Si l'app tournait deja, la nouvelle copie
reprend le serveur deja en marche (grace a `data/menubar.pid`).

Le script ne compile pas le serveur : faire `npm run build` une premiere fois, ou utiliser *Recompiler et redemarrer*
depuis le menu. Si `dist/cli/main.js` manque, *Demarrer* compile d'abord.

## Reglages

Le port et l'interface d'ecoute se reglent dans `data/machine/config.json` (`server.port`, `server.host`).
L'app lit le meme fichier. Un port regle par le registre (`HKCU\Software\LightMCPMenuBar\port`) passe avant
celui du fichier. Pour imposer un chemin de depot ou de node :

```powershell
# (via registre)
reg add HKCU\Software\LightMCPMenuBar /v repoPath /t REG_SZ /d "C:\chemin\light-mcp-server" /f
reg add HKCU\Software\LightMCPMenuBar /v nodePath /t REG_SZ /d "C:\Program Files\nodejs\node.exe" /f
```

## RTP-MIDI sur Windows

La session RTP-MIDI integree au serveur occupe souvent le port UDP 5004. Dans ce cas, le serveur demarre
quand meme, sans RTP-MIDI, et le signale dans ses journaux, dans `/health` et sur la page MIDI.