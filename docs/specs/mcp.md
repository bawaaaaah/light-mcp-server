# MCP : l'IA au service de la conception d'un spectacle

Comme dans wing-mcp-server : transports **HTTP streamable `/mcp`** et **stdio**, outils définis avec zod, **profils** d'outils pour limiter les tokens. Tous les outils passent par la **couche de commandes** et respectent les **droits du rôle** du token MCP : une session ne **liste** que les outils que son utilisateur peut appeler, chaque appel est vérifié avec ses droits, et une session reste à l'utilisateur qui l'a ouverte. En stdio, le client a lancé le serveur lui-même : tous les droits.

**Brancher un client** : en-tête `Authorization: Bearer <jeton>` (le jeton de `npm run light -- token`). La page **Connexion IA** de l'interface donne l'adresse, le jeton et la marche à suivre par client ; le [README](../../README.md#connecter-un-client-mcp) aussi. Hors du réseau local, le serveur se publie derrière un reverse proxy HTTPS (`server.publicUrl`, `server.host`, `server.port`). **OAuth 2.1** (repris de wing-mcp-server) dès que `server.publicUrl` est défini : enregistrement dynamique, page d'autorisation où l'on approuve avec une clé de sécurité (utilisateur qui a `mcp:use`) ou le jeton, code PKCE, jetons d'accès (24 h) et de rafraîchissement (tournants), valables sur `/mcp` seulement, avec les droits de qui a autorisé ; révocables par client (page Connexion IA) ou par RFC 7009. C'est le chemin de claude.ai ; Claude Desktop et Claude Code peuvent aussi passer par l'en-tête.

**Priorité (analyse critique) : la conception d'abord.** La vraie valeur de l'IA est de préparer, générer, vérifier et documenter les shows. Le pilotage en direct par l'IA viendra plus tard.

**Instructions à l'initialisation** (`getInstructions` du plugin) : un guide court que le client reçoit avant tout appel : sécurité (Panic, Blackout, veille, looks réservés à la main), lecture économe (`light_look_list` résumé, `light_look_get`), modifications sûres (références, suppressions refusées, versions, objets supprimés), vérifications et journal, chemin de conception. Un test vérifie que chaque outil cité existe.

## Périmètre
| v1 | Plus tard |
|---|---|
| Profils `setup`, `design`, `full` ; ressources ; prompts ; propositions et diff ; prévisualisation ; lint ; selftest ; exports | Profil `live` : retouches en direct (`light_live_adjust`) dans le cadre des règles, sans confirmation systématique (principe déjà validé) |

## Cycle de vie couvert
| Étape | Ce que fait l'IA avec l'utilisateur | Outils |
|---|---|---|
| Lieu et matériel | décrire la salle, ses zones et son matériel ; trouver les fixtures | `light_venue_*`, `light_stage_*`, `light_fixture_search`, `light_fixture_import` |
| Patch et réseau | proposer un patch, détecter les nodes, router les univers | `light_patch_plan`, `light_patch_check`, `light_discover_nodes`, `light_route_universe` |
| Mise au point | identifier les projecteurs, calibrer, poser rôles et zones protégées | `light_identify`, `light_calibrate_pantilt`, `light_position_aim` (et `light_position_set`, `light_position_release`), `light_protect_zone` |
| Canevas | définir les canevas et leur rendu sur le kit | `light_canvas_*`, `light_venue_map_canvas` |
| Conception | palettes, looks et techniques à partir d'une intention | `light_look_from_intent`, `light_palette_*`, `light_preset_*`, `light_technique_*` |
| Chants | remplir la grille d'un chant, générer boutons et timeline | `light_song_*`, `light_song_grid_fill`, `light_song_from_structure`, `light_timeline_*` |
| Interfaces | dashboards, groupes, mapping MIDI et OSC, exports Ableton | `light_dashboard_generate`, `light_group_*`, `light_map_midi`, `light_notes_registry`, `light_export_ableton`, `light_export_liveset` |
| Vérification | lint, auto-test de bout en bout | `light_lint`, `light_selftest` |
| Répétition | dérouler à blanc, sauter à une section, noter les retouches | `light_rehearse_*`, `light_song_goto`, `light_note_*` |
| Documentation et archive | feuille de conduite, planche, journal, versions | `light_export_cuesheet`, `light_export_board`, `light_show_log`, `light_show_snapshot` |

## Ressources
- `light://stage` : la scène en texte et en JSON (zones, protections, fixtures par rôle, ce qu'elles éclairent, notes).
- `light://show`, `light://patch`, `light://song/{id}`, `light://setlist`, `light://palettes`, `light://presets`.
- `light://groups` : arbre des groupes et niveaux.
- `light://rules` : règles actives et marges.
- `light://knowledge` : base de connaissances couleur active (générique, ou privée via plugin).
- `light://midi/map`, `light://osc/map`, `light://notes`, `light://log/{date}`.
- `light://live` : état en langage naturel.
- Fait : `light://show`, `light://venue` (patch, canevas, règles du lieu), `light://live`, `light://stage`, `light://knowledge`, et `light://rules` (règles, programmes, programme actif), `light://midi/map` (table Markdown), `light://osc/map`, `light://notes`, `light://log` (journal de la dernière semaine, droit `show:write`) ; ces cinq-là se lisent avec les droits de l'appelant. Restent : par chant, setlist, palettes et presets à part (dans `light://show`).
- Les ressources sont abonnables.

## Prompts (workflows guidés)
`setup_venue`, `define_canvas`, `program_song` (grille), `build_setlist`, `import_qlc_project` (import puis reconstruction), `rehearsal_review`, `preshow_check`.
- Fait (`plugins/light/mcp-prompts.ts`) : les sept, en français, sans logique propre : chacun enchaîne des outils existants (un test vérifie que chaque outil cité existe). `preshow_check` ne joue rien (l'auto-test seulement sortie en veille ou sur demande) ; `import_qlc_project` passe par la proposition, les définitions manquantes, puis l'application ; `rehearsal_review` part du journal d'activité.

## Principes des outils
- **Proposer puis appliquer** : les outils lourds renvoient un **diff** et un `proposalId`. Rien n'est écrit avant `light_apply(proposalId)`, qui applique en une transaction avec une seule entrée d'undo.
- **Prévisualiser sans sortir** : `light_preview` calcule un rendu sans envoyer de DMX (valeurs, résumé texte, image 2D). `light_preview_live` l'envoie sur un univers ou un node de test.
- **Écritures vérifiées** (comme wing) : relecture et `MISMATCH` en cas d'écart. Chaque réponse contient l'état en langage naturel et les **bornages appliqués** par les règles.
- **Sélecteurs par le sens** : `{ role, zone, group, tag, canvas, near, except }`, partagés avec l'UI. `light_select` explique ce qu'il retient.
- **Réutilisation** : les outils sont de minces adaptateurs sur les commandes existantes. **Aucune logique métier propre au MCP.**
- **Undo et versions** : `light_undo`, `light_redo`, `light_history` (avec l'origine) ; `light_show_snapshot`, `light_show_diff`, `light_show_restore`.
- **Profils** : `setup`, `design`, `full` (et plus tard `live`). On change de profil avec `light_tool_profile`, notifié par `tools/list_changed`.

## Outils de vérification et d'export
- `light_lint(show | song)` : contraste ΔE des couples, symétrie des miroirs, sections identiques ou inertes, looks qui écrivent de l'intensité, du strobe ou de l'UV contre les règles, conflits de notes, sections hors famille d'ambiance, **références cassées** (look, groupe, fader de canaux, programme, projecteur supprimé, canal hors du mode d'un projecteur), **noms en double** (looks, groupes, faders). `light_look_list` est **résumé par défaut** (sans pas ni paramètres de technique, qui pèsent près d'1 Mo sur un show importé ; `brief: false` pour tout) et `light_look_get(id)` donne un look entier ; un look de la liste résumée porte `partial: true` et `light_look_put` le refuse (le renvoyer tel quel perdrait ses pas ou ses canaux bruts). Un argument invalide est refusé avec le premier problème et son chemin (`arguments invalides pour look.put (look.timing.every : …)`). `light_show_references(kind, id)` dit où un look, un groupe ou un fader sert ; `light_look_delete`, `light_group_delete` et `light_fader_delete` refusent tant qu'il sert, sauf `force`.
- `light_selftest` : balaie les mappings, relit le DMX, mesure la cadence et contrôle l'exclusivité.
- `light_song_grid_fill({ structure | paroles, ambiance })` : propose la grille d'un chant à partir de la base de connaissances.
- `light_export_cuesheet`, `light_export_board`, `light_export_ableton`, `light_export_liveset`.

## Sécurité
- **Panic neutre** (`light_panic`) et **Blackout** (`light_blackout`) : sans confirmation, mappables en MIDI et OSC. Le Panic neutre coupe effets, strobe, UV et machines, puis rappelle le **secours choisi à l'avance pour le show** : un **instantané** (`light_snapshot_*` : l'état complet, looks lancés, DCA, faders de canaux, grand master, programme, Blackout, enregistré à l'avance), sinon le « look de secours ». **Si rien n'est défini, il fait un Blackout.** Les objets supprimés depuis l'enregistrement sont ignorés et listés.
- Les actions marquées **interdit à l'IA** ou **à confirmer**, et les sections `manualOnly`, sont refusées ou soumises à confirmation.
- **Priorité humaine** : un geste du régisseur annule une commande de l'IA en cours sur le même objet.
- Débit limité et **journal** de toutes les actions avec leur origine `mcp`.
- **Checklist pré-spectacle** (`preshow_check`) :
  - nodes présents ;
  - entrées MIDI actives ;
  - horloge reçue ;
  - setlist chargée ;
  - snapshot pris ;
  - look de secours du Panic neutre défini (sinon, avertissement : le Panic fera un Blackout).

## Intégrations
Les sources externes (catalogue de chants, analyse audio, AbleSet) passent par des **plugins**. Les plugins privés restent hors du dépôt ([plugins](plugins.md)). `light_song_from_structure` accepte une structure générique, quelle que soit sa provenance.

## Tests
- Serveur MCP en process, pour chaque profil : liste d'outils, schémas, appels, droits du rôle.
- Scénario de bout en bout : créer le lieu et le canevas, patcher, faire un look par intention, créer un chant avec sa grille, lint, selftest, Panic, rapport.
- Chaque écriture laisse une entrée d'undo et une ligne de journal `mcp`.
