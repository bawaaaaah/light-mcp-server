# Installer depuis npm (GitHub Packages)

Le paquet est publié sur **GitHub Packages** sous le nom `@bawaaaaah/light-mcp-server`, comme wing-mcp-server. Il contient le serveur compilé, l'interface web compilée, la ligne de commande (`light` et `light-mcp-server`) et le SDK TypeScript (`@bawaaaaah/light-mcp-server/sdk`). Rien n'est compilé sur ta machine à l'installation, hormis le module MIDI natif (binaire précompilé).

Une version est publiée automatiquement à chaque commit sur `main` dont les tests passent (CI, puis tag `vX.Y.Z`, puis publication). L'image Docker multi-architecture (amd64, arm64 pour le Pi) est publiée en même temps sur `ghcr.io/bawaaaaah/light-mcp-server`.

Autre option : [install.md](install.md) (depuis les sources ou Docker).

## Prérequis
- Node.js **22.6 ou plus** (`node --version`).
- Sous Linux, pour le MIDI local : le séquenceur ALSA (`sudo modprobe snd-seq`).

## S'authentifier auprès de GitHub Packages
Contrairement à npmjs.com, le registre npm de GitHub Packages demande un jeton **même pour lire** un paquet public. Créer un [jeton d'accès personnel](https://github.com/settings/tokens) (classic) avec le droit `read:packages`, puis le déclarer pour ce scope uniquement :

```ini
# ~/.npmrc
@bawaaaaah:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

La ligne `@bawaaaaah:registry` limite GitHub Packages à ce scope : les autres paquets continuent de venir de npmjs.com. npm remplace `${GITHUB_TOKEN}` par la variable d'environnement, ce qui évite d'écrire le jeton dans le fichier.

Vérifier : `npm view @bawaaaaah/light-mcp-server version`

## Installer
Le plus propre pour une machine de régie : un dossier à soi, qui contiendra aussi les données.

```bash
mkdir -p ~/lumiere && cd ~/lumiere
npm init -y
npm install @bawaaaaah/light-mcp-server
npx light pin regisseur 1234        # un PIN par rôle : admin, regisseur, benevole, lecture
npx light serve                     # ou : npx light serve --standby (QLC+ garde la main)
```

Avec npm 12, l'installation peut afficher « install scripts blocked » pour `@julusian/midi` et `@serialport/bindings-cpp` : c'est sans conséquence (les modules MIDI et port série sont livrés précompilés, le script ne fait que vérifier) ; `npm install-scripts approve @julusian/midi @serialport/bindings-cpp` fait taire l'avertissement.

Ou globalement : `npm install -g @bawaaaaah/light-mcp-server`, puis `light serve` depuis le dossier où vivront les données.

## Où sont les données
- Installé depuis npm, le serveur range tout dans **`./data` du dossier courant** (jamais dans `node_modules`, qu'une mise à jour effacerait) : configuration de la machine (`data/machine/config.json`), lieux, shows, sauvegardes, définitions de fixtures (`data/fixtures/`, y copier ses `.qxf`).
- `LIGHT_DATA_ROOT=/chemin` choisit un autre dossier ; `LIGHT_CONFIG_PATH` un autre fichier de configuration. Ces variables valent pour le serveur et pour la ligne de commande.

## Utiliser le SDK dans un script
```ts
import { LightClient } from "@bawaaaaah/light-mcp-server/sdk";

const light = await LightClient.login("http://localhost:8790", "1234");
await light.call("look.go", { id: "auto-joie" });
```
Voir [sdk/README.md](../sdk/README.md) (inclus dans le paquet, avec le client Python).

## Mettre à jour
```bash
cd ~/lumiere && npm update @bawaaaaah/light-mcp-server
```
Les données restent dans `./data`. Faire une sauvegarde `.lightshow` avant (`npx light pack`).
