# Spécifications d'implémentation — babana.cm

Un fichier par lot. Chaque tâche y est écrite pour être donnée telle quelle à Claude Code, sans reformulation.

## Structure d'une spécification

Chaque tâche suit le même format :

- **Objectif** — ce que la tâche produit, en une phrase
- **Contexte** — les décisions d'architecture qui la contraignent, avec leur référence
- **Fichiers** — où le code doit aller
- **Spécification** — le détail technique
- **Critères d'acceptation** — vérifiables, binaires
- **Pièges** — quand il y en a, ce qui rend la tâche plus délicate qu'elle n'en a l'air

## Convention de chemins

**Tous les chemins de fichiers indiqués dans ces spécifications sont relatifs à `code/`**, à la racine du monorepo.

`services/odoo/addons/babana/models/babana_ride.py` désigne donc `babana.cm/code/services/odoo/addons/babana/models/babana_ride.py`.

Les `docs/` mentionnés dans une spécification désignent `code/docs/` — la documentation technique produite par le développement : contrats, mesures, procédures d'exploitation. À ne pas confondre avec `amoa/`, qui porte les décisions et les spécifications elles-mêmes.

## Comment les utiliser

Une tâche par session de développement. Donner la spécification complète, plus `amoa/01-architecture.md` en référence. Ne pas donner plusieurs tâches à la fois : les critères d'acceptation perdent leur valeur quand ils se mélangent.

Respecter l'ordre des dépendances de `amoa/03-decoupage-taches.md` §5. Les trois contrats (`C-contrats.md`) passent avant tout code.

## Règles transverses

Elles s'appliquent à toutes les tâches et n'ont pas à être répétées dans chacune.

**Tout le code va dans `code/`.** `amoa/` est en lecture, sauf pour déposer un écart dans `amoa/questions/` — **toujours commité sur `master`**, même quand la tâche elle-même reste sur une branche non fusionnée.

**Les champs-pont sont tracés.** Quand l'ordre des tâches impose un champ transitoire, il porte `[PONT — remplacé par <ID-TACHE>]` dans son `help` et figure dans `code/docs/bridge-fields.md`. La tâche cible commence par le supprimer.

**Aucune règle métier dans les applications.** Ni calcul de tarif, ni décision d'affectation, ni validation de solde. L'application affiche ce que le serveur décide.

**Aucune valeur de configuration codée en dur.** Délais, rayons, plafonds, taux : tous paramétrables dans le back-office ou par variable d'environnement.

**Aucun secret dans le dépôt.** Clés, jetons, mots de passe : variables d'environnement uniquement.

**La règle de partition prime.** Une écriture Odoo par événement métier, jamais par tick GPS. Le service temps réel n'écrit jamais dans PostgreSQL. Si une tâche semble exiger le contraire, c'est la tâche qui est mal spécifiée — le signaler plutôt que contourner.

**Tout comportement spécifié a un test.** Une tâche dont les critères d'acceptation ne sont pas couverts par un test automatisé n'est pas finie.

**Le français pour les libellés utilisateur, l'anglais pour le code.** Noms de modèles, champs, fonctions et variables en anglais ; textes affichés en français, via le mécanisme de traduction Odoo côté back-office.

## Index

| Fichier | Lot | Tâches |
|---|---|---|
| `C-contrats.md` | Contrats préalables | C-01 à C-03 |
| `L0-socle.md` | Socle technique | L0-01 à L0-06 |
| `L1-identite.md` | Identité, comptes, flotte | L1-01 à L1-10 |
| `L2-tarification.md` | Tarification | L2-01 à L2-07 |
| `L3-temps-reel.md` | Service temps réel | L3-01 à L3-14 |
| `L4-course.md` | Boucle de course | L4-01 à L4-10 |
| `L5-caisse.md` | Caisse et recette | L5-01 à L5-07 |
| `L6-mobile.md` | Applications mobiles | L6-01 à L6-17 |
| `L7-notifications.md` | Notifications | L7-01 à L7-06 |
| `L8-securite.md` | Sécurité et conformité | L8-01 à L8-10 |
| `L9-backoffice.md` | Back-office et pilotage | L9-01 à L9-10 |
| `L10-qualite.md` | Qualité et pilote | L10-01 à L10-08 |
