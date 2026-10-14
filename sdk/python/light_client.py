"""Client Python minimal pour light-mcp-server (bibliothèque standard uniquement).

Toutes les actions passent par la couche de commandes du serveur, comme les outils MCP et
les adresses OSC. Liste des commandes et de leurs arguments : ``client.commands()`` ou
``GET /api/plugins/light/openapi.json``.

    from light_client import LightClient
    light = LightClient.login("http://localhost:8790", "1234")
    light.call("look.go", id="joie")
    print(light.call("selftest.run", cadence=True))
"""
from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Any


class LightError(Exception):
    def __init__(self, status: int, message: str, detail: Any = None):
        super().__init__(message)
        self.status = status
        self.detail = detail


class LightClient:
    def __init__(self, url: str, token: str, timeout: float = 30.0):
        self.url = url.rstrip("/")
        self.token = token
        self.timeout = timeout
        self.role: dict | None = None

    @classmethod
    def login(cls, url: str, pin: str) -> "LightClient":
        body = _request(url.rstrip("/") + "/api/auth/login", data={"pin": pin})
        client = cls(url, body["token"])
        client.role = body.get("role")
        return client

    def _get(self, path: str) -> Any:
        return _request(self.url + path, token=self.token, timeout=self.timeout)

    def call(self, command: str, args: dict | None = None, **kwargs: Any) -> Any:
        """Lance une commande : ``call("look.go", id="joie")`` ou ``call("dmx.set", {...})``."""
        payload = {**(args or {}), **kwargs}
        body = _request(f"{self.url}/api/plugins/light/commands/{command}", data=payload, token=self.token, timeout=self.timeout, what=command)
        return body.get("result")

    def commands(self) -> list[dict]:
        return self._get("/api/plugins/light/commands")

    def state(self) -> dict:
        return self._get("/api/plugins/light/state")

    def download_archive(self, venue: bool = True) -> bytes:
        req = urllib.request.Request(f"{self.url}/api/plugins/light/archive{'' if venue else '?venue=0'}", headers={"authorization": f"Bearer {self.token}"})
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as res:
                return res.read()
        except urllib.error.HTTPError as err:
            raise LightError(err.code, err.reason) from None


def _request(url: str, data: Any = None, token: str | None = None, timeout: float = 30.0, what: str = "") -> Any:
    headers = {"content-type": "application/json"}
    if token:
        headers["authorization"] = f"Bearer {token}"
    body = json.dumps(data).encode() if data is not None else None
    req = urllib.request.Request(url, data=body, headers=headers, method="POST" if body is not None else "GET")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return json.loads(res.read() or b"{}")
    except urllib.error.HTTPError as err:
        try:
            info = json.loads(err.read() or b"{}")
        except ValueError:
            info = {}
        prefix = f"{what} : " if what else ""
        raise LightError(err.code, prefix + str(info.get("error", err.reason)), info.get("detail")) from None


if __name__ == "__main__":
    # Banc de test minimal : python3 light_client.py http://localhost:8790 <pin>
    import sys

    if len(sys.argv) < 3:
        sys.exit("usage : light_client.py <url> <pin> [--cadence]")
    light = LightClient.login(sys.argv[1], sys.argv[2])
    result = light.call("selftest.run", cadence="--cadence" in sys.argv)
    print(f"Mappings : {result['passed']}/{result['total']} · latence {result['latencyMs']['p50']} ms (max {result['latencyMs']['max']} ms)")
    for f in result["failed"]:
        print(f"  ✖ {f['label'] or f['mapping']} : {f['reason']}")
    for e in result["exclusivity"]:
        print(f"  {'✔' if e['ok'] else '✖'} exclusivité {e['group']}")
    for c in (result.get("cadence") or {}).get("looks", []):
        print(f"  {'✔' if c['ok'] else '✖'} cadence {c['look']} {c.get('measuredMs', '—')} / {round(c['expectedMs'])} ms")
    sys.exit(0 if not result["failed"] and all(e["ok"] for e in result["exclusivity"]) else 1)
