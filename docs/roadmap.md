# Feuille de route

## Étape 0 : prototypes (avant tout développement)
On valide d'abord les paris techniques risqués, en jetables. Chaque prototype laisse une note de résultat dans `docs/research/proto-<sujet>.md` : mesures, problèmes, décision.

| # | Prototype | Critère de réussite |
|---|---|---|
| P1 | **MIDI depuis Node sur le Mac** : bus IAC local et RTP-MIDI, auto-détection et hotplug | Notes et CC reçus depuis Ableton par les deux chemins, sans perte, latence mesurée |
| P2 | **Tick DMX** : 16 univers × 512 canaux à 44 Hz, sortie Art-Net | Gigue mesurée ; **MIDI → DMX < 10 ms** ; aucune trame perdue sur 10 min |
| P3 | **Rack `.adg`** cloné depuis la coquille de l'utilisateur | Le rack s'ouvre dans Live 12, les chaînes sont nommées et les key zones correctes |
| P4 | **Clock et SPP depuis Ableton** | BPM suivi à ±0,5 ; position retrouvée après un saut dans l'arrangement |
| P5 | **Aftertouch dans un clip Ableton** | Pression reçue pendant une note tenue (mode Momentané) |
| P6 | **Découverte Art-Net** sur le réseau réel | ArtPollReply des nodes reçus et décodés |

## Étape 1 : v0 « prochain culte »
**Objectif** : remplacer le pipeline QLC+ actuel de l'utilisateur sur **un vrai événement**.

**Périmètre minimal**
- Serveur natif sur le Mac et sortie Art-Net.
- Patch d'un lieu par import `.qxw`, avec un canevas et son rendu.
- Techniques à pas (damier, palette qui tourne, masques, respiration, flash), attaque, cadence au BPM par MIDI clock.
- Groupes avec master et exclusivité.
- MIDI depuis Ableton (Déclencher, Latch, Momentané), registre de notes, export du MIDI Effect Rack.
- Panic neutre (preset de secours du show, sinon Blackout) et Blackout.
- Un dashboard simple et la console DMX.

**Critères d'acceptation**
- La batterie de tests actuelle de l'utilisateur, rejouée contre le nouveau serveur, passe : balayage de toutes les notes et CC, relecture du DMX, mesure de la cadence, exclusivité.
- Une répétition complète sans incident.

**Plan de secours**
- QLC+ reste prêt à prendre la main pendant toute la transition : mêmes nodes et un Art-Net qu'on bascule.
- La procédure de bascule est écrite dans la doc.

## Étape 2 : phases en parallèle
Ces chantiers avancent ensemble. Chacun a sa spec :
- sortie et réseau ;
- lieu, fixtures et scène ;
- moteur et effets ;
- groupes et règles ;
- MIDI, OSC et Ableton (Live Set) ;
- UI et dashboards (FR/EN) ;
- chants et setlist ;
- données, CLI et SDK ;
- MCP de conception ;
- plugins ;
- rôles (PIN) ;
- déploiement « serveur distant » (Linux, Raspberry Pi, image Docker multi-arch) alimenté en RTP-MIDI. Le Mac natif reste la plateforme de référence.

## Plus tard
- IA en live (retouches) et cascade complète des règles.
- Comptes nominatifs, liens et QR.
- Max for Live (avec Live Suite) et connecteur AbleSet.
- Synchronisation audio (plugin) et analyse audio des chants.
- Vue 3D, Ableton Link, OS2L.
- MIDI clock en sortie, RDM.
