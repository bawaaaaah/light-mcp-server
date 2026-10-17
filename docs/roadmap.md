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
| P7 | **RTP-MIDI en pur Node** (sans démon) | Session avec le Mac : invitation, synchro, notes dans les deux sens |
| P8 | **Génération de Live Set** | Le `.als` généré s'ouvre dans Live sans plantage ; repères, clips et tempo corrects |
| P9 | **Flux WebSocket** 16 univers vers N écrans | 25 Hz par client ; un client lent n'affecte pas les autres |
| P10 | **sACN** | Multicast reçu sans perte |
| P11 | **OSC** | Routes, `/light/help`, latence |
| P12 | **Import `.qxw` et reconnaissance des techniques** | Techniques reconnues sur un vrai workspace (cible : ≥ 90 %) |

## Avancement (2026-10-15)
| Chantier | État |
|---|---|
| Prototypes P1–P12 | 6 validés ici ; 6 à confirmer avec le matériel de l'utilisateur |
| Socle serveur (cœur wing, rôles PIN, MCP, WebSocket) | ✅ |
| Sortie Art-Net/sACN, découverte | ✅ (à valider sur le réseau lumière) |
| Lieu, canevas, scène, règles | ✅ v1 |
| Techniques, lecteur, groupes, panic | ✅ |
| MIDI (modes, retour, registre), OSC, tempo | ✅ (validé sur le Mac : bus IAC, horloge, SPP et aftertouch depuis Live ; hotplug USB à tester) |
| Chants, setlist, suivi SPP | ✅ |
| Import QLC+ + auto-test (critère v0) | ✅ **vrai show sur le Mac : 92/92 mappings, cadence 100 %** ; depuis le 2026-10-15 : Scenes, matrices RGB, faders Playback et Submasters, machines, gradateur générique ; vérifié sur les 16 workspaces de l'utilisateur (aucune définition manquante) ; **à réimporter sur le Mac** |
| Exports Ableton (rack, Live Set), conduite | ✅ rack chargé dans Live ; Live Set à ouvrir dans Live |
| Conception assistée + ressources MCP | ✅ v1 |
| Interface web | ✅ v0 complète (10 pages), vérifiée dans Chromium par Playwright (`npm run test:ui`, 33 scénarios, dont toutes les pages au format tablette, portrait et paysage, sans débordement) ; reste à la voir sur une vraie tablette et sur le Mac |
| Docker / Pi / serveur distant | ✅ image vérifiée (Pi à tester) |
| Archives `.lightshow`, notes partout, Web MIDI, explorateur OSC | ✅ |
| Éditeur de looks (paramètres, pas, cadence, Move FX, aperçu animé) | ✅ |
| Éditeur de chants et de setlists (sections, timeline, remplir la grille) | ✅ |
| Presets automatiques (premier allumage immédiat) | ✅ |
| Actions de la timeline des chants, lecture sans DAW | ✅ |
| Planche (storyboard SVG d'un chant) | ✅ |
| Aperçu 2D en direct de la scène (couleurs relues dans la sortie ; orientation, faisceaux, strobe, zoom) | ✅ |
| Lyres (pan/tilt 16 bits, Move FX, viser une zone, pad XY, roue de couleurs, import des EFX QLC+) | ✅ calibration guidée comprise (à valider sur une vraie lyre et un vrai workspace avec EFX) |

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
- La procédure de bascule est écrite dans la doc : ✅ [bascule-qlc.md](bascule-qlc.md) (sortie en veille, alerte « autre console », `light serve --standby`) ; à répéter sur le vrai réseau ([tests-mac](tests-mac.md), étape 5 bis).

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
- ~~IA en live (retouches) et cascade complète des règles~~ : faits le 2026-10-17 (`light_live_adjust`, règles complètes).
- ~~Comptes nominatifs, liens et QR~~ : faits (utilisateurs, liens de partage, QR code).
- Max for Live (avec Live Suite) et connecteur AbleSet.
- ~~Vue 3D de la scène~~ : faite (Scène en direct, bouton « 3D »).
- Synchronisation audio (plugin) et analyse audio des chants (le tempo depuis un enregistrement est fait ; restent les sections et la synchronisation en direct).
- Vue 3D, Ableton Link, OS2L.
- MIDI clock en sortie, RDM.
