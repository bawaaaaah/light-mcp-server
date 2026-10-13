# Retours utilisateurs : douleurs connues et réponses du projet

| # | Douleur constatée | Outil(s) | Réponse dans light-mcp-server |
|---|---|---|---|
| 1 | Plantages, effets bloqués, glitches DMX | QLC+, Daslight | Moteur testé de façon déterministe (horloge injectée), séparation moteur/UI (un crash de l'UI ne coupe pas la sortie), watchdog, sortie continue même si l'UI est déconnectée |
| 2 | **Fichiers de show corrompus lors des mises à jour** | QLC+ | `schemaVersion` dans le show, **migrations** testées, backups tournants avant chaque migration et chaque sauvegarde |
| 3 | Des fonctionnalités qui ne se combinent pas, par exemple impossible de passer de la Simple Desk à la Virtual Console | QLC+ | Une **seule couche de commandes** : tout ce qui est dans le programmer (même réglé depuis la console DMX) peut être stocké en scène, cue ou preset depuis n'importe quelle page |
| 4 | Configurer chaque widget à la main, et refaire le travail quand on change de fixtures | QLC+ | Widgets liés à des **groupes ou rôles** (et non à des canaux), **modèles de widgets**, **reciblage en masse**, attributs normalisés indépendants du type de fixture |
| 5 | Pas de réutilisation des couleurs entre effets | QLC+ | **Palettes par référence** : on change la palette et tous les presets qui l'utilisent suivent |
| 6 | Effets difficiles sur les canaux non RGB | QLC+ | Le générateur FX cible **n'importe quel attribut** (zoom, gobo, strobe, pan…) |
| 7 | Fade-out ou grand master bogués | QLC+ | Spécification stricte de la fusion (HTP, LTP, masters) et tests dédiés |
| 8 | **Pas de suivi d'une MIDI clock externe** (QLC+ ne peut pas être esclave) : il faut dupliquer les chasers par tempo | QLC+ | Horloge esclave MIDI clock 24 ppqn avec lissage, SPP, et **durées musicales** qui suivent le BPM sans dupliquer quoi que ce soit |
| 9 | Retour LED MIDI capricieux (messages d'init, flash qui ne s'allument pas) | QLC+ | Profils avec **init explicite optionnelle** (rien par défaut), retour émis à chaque changement d'état quelle qu'en soit l'origine, testeur de feedback dans la page MIDI |
| 10 | Latence MIDI, au point que certains passent en OSC pour le Launchpad | QLC+ | Chemin MIDI vers commande vers moteur sans passer par l'UI, entrée **OSC** également |
| 11 | Effets **non éditables** une fois générés (convertis en chaser) | Daslight | Les effets restent des **objets paramétriques** jusqu'à la sortie, éditables en direct |
| 12 | Interface web sans contrôle de vitesse | QLC+ | Vitesse, BPM et tap présents dans le widget FX et dans l'API |
| 13 | Analyse automatique imprécise (phrases décalées d'un temps), presets qui perdent leurs données | SoundSwitch | On privilégie le **déclenchement explicite** (boutons, timeline, MIDI). L'analyse audio viendra plus tard et en option, et la persistance des presets est testée |
| 14 | **Une position non voulue s'allume pendant un morceau** (un pupitre éclairé pendant un break de danse) | SoundSwitch | **Zones et fixtures protégées** et **masques par section ou chant** (exclure un rôle ou une zone), notion de « look sûr » |
| 15 | Impossible de traiter séparément les cellules d'une fixture multi-cellules | SoundSwitch | Les cellules sont adressables individuellement dans le patch et dans les FX |
| 16 | Pas de contrôle du blanc RGBW ou des canaux spéciaux | SoundSwitch | Les capabilities OFL couvrent W, A, UV et les canaux spéciaux |
| 17 | Courbe d'apprentissage (MagicQ, SoundSwitch, Wolfmix) | divers | Presets générés automatiquement dès le patch (comme la Wolfmix), assistant de démarrage, dashboards par défaut, notes contextuelles |
| 18 | Coût (abonnements Lightkey, dongles Daslight) | Lightkey, Daslight | Projet libre, avec n'importe quel node Art-Net ou sACN |
| 19 | Mise à jour qui casse la disposition (panneaux qui disparaissent) | QLC+ | Dashboards versionnés, import et export JSON, migrations testées |
| 20 | Il faut recréer les séquences dans le piano roll de la DAW pour avoir un synchronisme parfait | QLC+ et Ableton | **Export Drum Rack nommé et `.mid` par chant**, timeline suivant le SPP |

## À creuser lors du point
- La communauté Reddit (r/lightingdesign, r/daslight, r/lightkey) a été peu accessible avec les outils utilisés. On peut approfondir si besoin.
- Les retours du forum QLC+ sont nombreux. On pourrait en faire une analyse plus systématique : feature requests les plus votées.
