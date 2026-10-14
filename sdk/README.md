# SDK de scripts

Deux clients minces, **sans dépendance**, sur l'API HTTP du serveur. Toute action passe par la même couche de commandes que l'interface, les outils MCP et les adresses OSC : un script ne contourne jamais les droits, les règles ni l'exclusivité.

- **Liste des commandes et de leurs arguments** : `npm run light -- commands`, ou la description OpenAPI `GET /api/plugins/light/openapi.json` (avec le jeton).
- **Jeton** : connexion par PIN (le rôle s'applique), ou jeton maître (`npm run light -- token`) pour un script de confiance sur la machine.

## TypeScript (Node ≥ 22 ou navigateur)
```ts
import { LightClient } from "@bawaaaaah/light-mcp-server/sdk"; // installé depuis GitHub Packages
// dans le dépôt : import { LightClient } from "./src/sdk/index.js";

const light = await LightClient.login("http://localhost:8790", "1234");
await light.call("look.go", { id: "auto-joie" });
const stop = light.subscribe("light:song", (s) => console.log("section", s));
const result = await light.call("selftest.run", { cadence: true });
```
Les types du show (`Look`, `Song`, `Mapping`…) sont réexportés depuis le serveur.

## Python (3.9 +, bibliothèque standard)
```python
from light_client import LightClient

light = LightClient.login("http://localhost:8790", "1234")
light.call("look.go", id="auto-joie")
print(light.call("selftest.run", cadence=True))
```
`python3 sdk/python/light_client.py http://localhost:8790 <pin> [--cadence]` lance l'auto-test et rend un code de sortie utilisable dans un banc de test (0 = tout va bien).

## Erreurs
`LightError` porte le statut HTTP : 400 arguments invalides, 401 jeton ou PIN refusé, 403 droit manquant, 404 commande inconnue, 422 la commande a échoué.
