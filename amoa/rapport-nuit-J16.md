# Rapport de nuit — J16

Tenu au fil de l'eau, une entrée par tâche finie, commitée avec elle (point 8 de la définition de
fini, `CLAUDE.md`). `amoa/questions/REPONSES-2026-08-24.md` lu en entier avant d'ouvrir quoi que ce
soit. Périmètre : les trois correctifs (L6-07, C-02 lecture des trames, le flake), puis L3-08 et
L6-09.

---

## Le flake — sérialisation de `services/realtime`

Quatre fichiers touchés par le même défaut depuis J12 (`DisconnectGraceTimers`,
`availability.test.ts`), J14 (`proposal.test.ts` critère 1, `reservation.test.ts` critère 5) et
J15 (`nearby.test.ts`, timer de diffusion) : tous des tests qui mesurent du temps réellement
écoulé (délai d'acceptation, expiration de réservation, période de grâce, intervalle de
diffusion), et le test-runner de Node exécute les fichiers passés sur la ligne de commande en
parallèle par défaut. Sous charge combinée (toute la suite du paquet, plus les autres paquets en
tâche de fond), la concurrence entre processus retarde suffisamment un `setTimeout` pour que la
fenêtre temporelle du test ne corresponde plus à ce qu'il attend. Chaque fichier isolé était et
reste vert — c'est la concurrence *entre* fichiers qui fautait, jamais leur contenu.

**Corrigé par `--test-concurrency=1`** sur la commande de test de `services/realtime/package.json`,
plutôt que d'allonger les délais des quatre fichiers : allonger masquerait le symptôme sans
changer la cause, et le prochain fichier de minuteur ajouté au paquet referait le même flake avec
une marge simplement plus confortable. Sérialiser l'exécution des fichiers retire la cause
elle-même — les tests ne se disputent plus le processeur entre eux. Le coût est une suite un peu
plus longue (~16,6 s contre une exécution parallèle plus rapide mais instable) ; c'est le bon
compromis pour une suite qui doit rester bloquante en continu (CLAUDE.md, « un test instable est
traité comme un défaut, pas toléré »).

**Vérifié** : suite complète de `services/realtime` (119 tests) exécutée deux fois de suite contre
Redis réel, 0 échec les deux fois — la vérification demandée par le piège de L3-13 appliquée ici
par analogie (« à vérifier plusieurs fois, sinon ça ne prouve rien »).

**Fichier.** `services/realtime/package.json` (un seul : la cause était unique, la sérialisation du
paquet la couvre entièrement, pas seulement les quatre fichiers historiquement touchés).

---
