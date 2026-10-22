# Bascule entre QLC+ et light-mcp-server

Pendant la transition (v0), **QLC+ reste prêt à reprendre la main** ([roadmap](roadmap.md), plan de secours). Les deux logiciels tournent en même temps et suivent Ableton ; **un seul envoie de l'Art-Net** à la fois. Passer de l'un à l'autre prend quelques secondes et ne coupe pas la musique.

## Principe
- **MIDI** : QLC+ et le serveur écoutent le **même bus IAC** (CoreMIDI accepte plusieurs écouteurs). Les deux suivent donc les notes et l'horloge d'Ableton en permanence, y compris celui qui n'envoie pas.
- **Sortie** : le serveur a un mode **« Sortie en veille »** : le show tourne et suit le MIDI, l'interface montre tout, mais **rien n'est envoyé aux nodes**. Côté QLC+, on coupe la sortie de l'univers.
- **Indicateurs** (en-tête de l'interface, sur toutes les pages) :
  - « ⏸ Veille » : le serveur n'envoie rien ;
  - « ⚠ Autre console sur le réseau » (rouge) : une autre source Art-Net envoie **pendant que le serveur envoie** ; les nodes mélangent les deux, il faut en mettre une en veille ;
  - page **Réglages** : les autres sources vues, et les nodes qui signalent une **fusion** de deux sources.
- **Pourquoi attendre** : un node qui reçoit deux sources garde la dernière trame d'une source muette **environ 10 secondes** (règle de fusion Art-Net). En passant en veille, le serveur envoie une dernière trame **à zéro** (neutre en fusion HTP ; en LTP, la trame suivante de QLC+ l'emporte aussitôt). QLC+ ne le fait pas : après avoir coupé sa sortie, attendre que l'avertissement disparaisse.

## Préparation (avant l'événement)
1. Mêmes univers des deux côtés : univers du serveur → port-address Art-Net identique à celle de QLC+ (page Réglages, « Univers 1 → Art-Net 0 »).
2. **QLC+ et le serveur sur le même Mac** : mettre `"discovery": false` dans la configuration du serveur (`data/machine/config.json`, section `light`) et indiquer l'IP des nodes dans les routes (`"targets": ["<ip du node>"]`), ou garder la diffusion (broadcast).
   - Raison : la découverte du serveur occupe le port UDP 6454. Il n'est pas encore vérifié que QLC+ accepte de le partager ([tests-mac](tests-mac.md), étape 5) ; sans découverte, le serveur ne gêne jamais QLC+.
   - Conséquence : l'avertissement « autre console » ne fonctionne pas sur ce Mac (il faut écouter le port 6454) ; suivre la procédure à la lettre.
3. Lancer **QLC+** avec le workspace habituel, sortie Art-Net active : c'est lui qui tient la lumière.
4. Lancer le serveur **en veille** : `npm run serve -- --standby`. L'état est enregistré : un redémarrage reste en veille.
5. Vérifier dans l'interface du serveur que les sections suivent Ableton (page Live ou Chants, moniteur de la console DMX).
6. Page **Show → « Vérifier le show »** : aucune erreur (✖). Les alertes (⚠) se lisent une à une : chevauchement d'adresses, projecteur sans définition, libellés ambigus, une même entrée MIDI qui pilote deux cibles (voulu si le workspace QLC+ le faisait).
7. Page **Fichiers** : une **sauvegarde nommée** juste avant le service (la sauvegarde automatique du jour ne date que du dernier changement).
8. **Tablettes** : ouvertes depuis l'écran d'accueil, « Rester connecté sur cet appareil » coché sur les tablettes dédiées, Live en plein écran (l'écran reste allumé en HTTPS). **Réglages → « En ligne maintenant »** dit lesquelles sont connectées, et sous quel compte ; le **journal d'activité**, plus bas, dit après coup qui a fait quoi.

## Passer à light-mcp-server
1. QLC+ : onglet **Entrées/Sorties** (*Inputs/Outputs*), univers concerné, **décocher la sortie Art-Net** (ou fermer QLC+). Le bouton *Blackout* de QLC+ ne suffit pas : il continue d'envoyer des zéros.
2. Attendre **10 secondes** (fusion des nodes), ou que l'avertissement de fusion disparaisse dans Réglages quand la découverte est active.
3. Serveur : **Réglages → « ▶ Reprendre la main »** (confirmation demandée). Tous les univers partent aussitôt avec l'état courant du show.
4. Contrôler sur scène : la section en cours, le Panic, le Blackout.

## Revenir à QLC+ (secours)
1. QLC+ : **recocher la sortie Art-Net** de l'univers. Pendant un instant les deux sources envoient (avertissement rouge si la découverte est active) : c'est voulu, la lumière ne s'éteint pas.
2. Serveur : **Réglages → « ⏸ Mettre en veille »**. Le serveur envoie sa trame à zéro puis se tait ; QLC+ reste seul.
3. En urgence, sans interface : `light serve --standby` au prochain démarrage, ou couper le serveur (Ctrl-C) puis cocher la sortie de QLC+ et attendre 10 s.

## Points à vérifier en répétition
- Le node utilisé (fusion HTP ou LTP, durée de maintien d'une source muette) : noter le comportement dans [research/proto-resultats.md](research/proto-resultats.md) (P6).
- **Interface DMX USB** : un port série n'est tenu que par un programme à la fois. En veille, le serveur lâche ses interfaces DMX USB : QLC+ peut les ouvrir (relancer sa sortie « DMX USB » si elle était en erreur). Avant de reprendre la main côté serveur, couper la sortie USB de QLC+, sinon le serveur ne peut pas ouvrir l'interface (Réglages, « Interfaces DMX USB » : l'erreur s'affiche, il réessaie toutes les 2 s).
- Les retours MIDI (LED des contrôleurs) : le serveur n'en envoie aucun pendant la veille et les renvoie tous en reprenant la main. Côté QLC+, couper son retour (*feedback*) quand le serveur tient la lumière, sinon les deux écrivent sur les LED.
