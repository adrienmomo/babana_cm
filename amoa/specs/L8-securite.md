# L8 — Sécurité et conformité

CDC §VII.2, §VII.3 et §VII.4. **À traiter comme des tâches, pas comme des intentions.**

---

## L8-01 — Règles d'enregistrement Odoo

### Objectif

Un utilisateur mobile n'accède qu'à ses propres données.

### Contexte

Les utilisateurs mobiles n'appartiennent à aucun groupe métier (L0-02). Leurs droits passent **exclusivement** par des règles d'enregistrement.

### Fichiers

```
services/odoo/addons/babana/security/babana_record_rules.xml
services/odoo/addons/babana/security/ir.model.access.csv
```

### Spécification

Règles à définir, modèle par modèle :

| Modèle | Client | Chauffeur |
|---|---|---|
| `babana.ride` | Ses courses uniquement | Ses courses uniquement |
| `babana.driver` | Champs publics des chauffeurs proches | Sa propre fiche |
| `babana.driver.document` | Aucun accès | Ses propres documents |
| `babana.motorcycle` | Champs publics de la moto de sa course | Sa moto affectée |
| `babana.cash.movement` | Aucun accès | Ses propres mouvements |
| `babana.cash.remittance` | Aucun accès | Ses propres remises |
| `account.move` | Ses propres factures | Aucun accès |
| `res.partner` | Sa propre fiche | Fiche du client de sa course active uniquement |

**La dernière ligne est la plus délicate** : le chauffeur doit joindre son passager pendant la course, et ne doit plus y accéder après. La règle doit être conditionnée à l'existence d'une course active, pas à un historique.

Les droits d'accès aux modèles sont restrictifs par défaut : aucune écriture pour les utilisateurs mobiles, sauf par les méthodes de transition et les contrôleurs.

Vérifier explicitement les modèles Odoo standard exposés par héritage — `res.users`, `hr.employee`, `account.move` — qui peuvent laisser fuir des données par des champs relationnels non protégés.

### Critères d'acceptation

1. Chaque ligne du tableau a sa règle.
2. Un client ne lit aucune course d'un autre client.
3. Un chauffeur ne lit aucun document d'un autre chauffeur.
4. Le chauffeur accède au partenaire client pendant la course et plus après.
5. Aucun utilisateur mobile n'a de droit d'écriture direct sur un modèle.
6. Les modèles standard hérités ne laissent fuir aucune donnée par relation.

---

## L8-02 — Tests d'habilitation

### Objectif

Prouver L8-01.

### Contexte

Les habilitations Odoo sont faciles à croire correctes et faciles à avoir fausses. **Seul un test qui tente l'accès interdit prouve quelque chose.**

### Fichiers

```
services/odoo/addons/babana/tests/test_access_rights.py
services/odoo/addons/babana/tests/fixtures/access_matrix.json
```

### Spécification

Matrice d'accès dans un fichier de données : pour chaque combinaison rôle × modèle × opération, le résultat attendu — autorisé ou refusé.

Les tests sont **générés** depuis cette matrice. Ajouter un modèle sans l'ajouter à la matrice fait échouer la suite : c'est ce qui empêche qu'un modèle nouveau échappe au contrôle.

Chaque test refusé doit tenter l'accès **au nom de l'utilisateur concerné**, pas en super-utilisateur avec un filtre. Un test qui contourne le mécanisme de sécurité ne teste pas la sécurité.

Cas particuliers à couvrir :

- Chauffeur tentant de lire le partenaire client après la fin de course
- Client tentant de lire un document chauffeur par une relation
- Chauffeur tentant de modifier son propre solde
- Chauffeur tentant de valider sa propre remise
- Utilisateur mobile tentant d'écrire directement `state` sur une course
- Lecture d'un modèle standard par une relation non protégée

### Critères d'acceptation

1. Les tests sont générés depuis la matrice.
2. Un modèle absent de la matrice fait échouer la suite.
3. Les tests s'exécutent au nom de l'utilisateur, sans super-utilisateur.
4. Les six cas particuliers sont couverts.
5. La suite tourne en intégration continue.

---

## L8-03 — Partage de trajet

### Objectif

Permettre à un proche de suivre le trajet (CDC §II.6).

### Contexte

Implique une **route publique non authentifiée**, consultable dans un navigateur par quelqu'un qui n'a pas l'application.

### Fichiers

```
services/realtime/src/share/handler.ts
services/realtime/src/share/page.ts
services/odoo/addons/babana/models/babana_ride_share.py
services/realtime/test/share.test.ts
```

### Spécification

Le client déclenche le partage depuis l'écran de suivi. Génération d'un **jeton opaque non devinable**, de longueur suffisante, tiré d'un générateur cryptographique — jamais dérivé de l'identifiant de course.

URL courte partageable par tout canal — SMS, messagerie. Forme retenue : `https://babana.cm/s/{token}`, servie depuis l'apex et non depuis un sous-domaine. Le lien part par SMS à un proche, souvent lu sur un petit écran et sur un forfait limité : la brièveté et la lisibilité du domaine font partie de la fonction.

Page web légère, servie par le service temps réel sur `/s/{token}` derrière l'apex : carte, position du chauffeur, ETA, destination. Rien d'autre. La page doit rester utilisable sur un navigateur de terminal d'entrée de gamme et sur un réseau lent — pas de dépendance lourde.

**Exposition minimale, en liste blanche** : position, ETA, destination, prénom du chauffeur, gamme de moto. **Jamais** le nom du client, son téléphone, l'historique, le montant, ni l'identité complète du chauffeur.

Expiration : à la fin de la course plus un délai court configurable. Après expiration, la page affiche que le trajet est terminé, sans donnée.

Révocation possible par le client à tout moment.

Limitation de débit par jeton : un jeton partagé publiquement ne doit pas devenir un point de charge.

### Critères d'acceptation

1. Le jeton est cryptographiquement aléatoire, sans lien avec l'identifiant de course.
2. La page n'expose que les champs en liste blanche — test vérifiant l'absence des autres.
3. L'expiration fonctionne, testée en avançant l'horloge.
4. La révocation est immédiate.
5. La page est consultable sans compte ni application.
6. La limitation de débit par jeton est appliquée.

---

## L8-04 — Bouton d'urgence et incidents

### Objectif

Alerter en cas de problème (CDC §II.6).

### Fichiers

```
services/odoo/addons/babana/models/babana_incident.py
services/odoo/addons/babana/controllers/incident.py
apps/client/src/components/EmergencyButton.tsx
apps/driver/src/components/EmergencyButton.tsx
```

### Spécification

Modèle `babana.incident` : course, déclencheur, type, position au déclenchement, horodatage, statut, traitement, auteur du traitement.

Déclenchement depuis client et chauffeur, pendant une course. Accessible **en un geste** depuis l'écran de course — l'utilité tient entièrement à l'accessibilité en situation de stress.

Effets immédiats :

1. Enregistrement de l'incident avec la position exacte
2. Alerte au back-office, visible sans délai
3. Notification au contact d'urgence du client s'il est renseigné (L1-04)
4. La course continue — l'alerte n'interrompt rien automatiquement

Le point 4 est délibéré : couper la course automatiquement pourrait aggraver une situation dangereuse. La décision revient à un humain au back-office.

**Confirmation en deux temps** pour éviter les déclenchements accidentels dans une poche, mais rapide : un appui long, pas une boîte de dialogue à lire.

Le déclenchement fonctionne hors connexion : mis en file et envoyé dès que possible, avec la position et l'horodatage d'origine.

### Critères d'acceptation

1. Le bouton est atteignable en un geste depuis l'écran de course.
2. Le déclenchement enregistre la position exacte.
3. **L'alerte apparaît au back-office sans délai — c'est la notification qui compte** (D48, 30 août). Le superviseur peut appeler, voir la position, alerter ; un proche ne peut que s'inquiéter. Le canal qui produit une action passe donc en premier, et il ne dépend d'aucun fournisseur externe.
4. **Le contact d'urgence est notifié quand une passerelle existe**, et l'enregistrement distingue toujours **l'intention de la livraison** : un indicateur qui dirait « notifié » sans qu'aucun message ne soit parti serait un mensonge sur la seule fonction du produit où mentir coûte le plus cher. Tant qu'aucune passerelle n'est choisie — la même que celle dont L1-09 a besoin pour l'OTP —, l'intention est enregistrée et le reste explicitement non tenu.
5. La course n'est pas interrompue automatiquement.
6. Le déclenchement hors connexion est mis en file avec sa position d'origine.

---

## L8-05 — Signalements et litiges

### Objectif

Traiter les réclamations (CDC §VII.4).

### Fichiers

```
services/odoo/addons/babana/models/babana_dispute.py
services/odoo/addons/babana/views/babana_dispute_views.xml
apps/client/src/screens/ReportScreen.tsx
apps/driver/src/screens/ReportScreen.tsx
```

### Spécification

Signalement depuis l'historique d'une course, par le client ou le chauffeur.

Catégories : montant contesté, comportement, sécurité, itinéraire, autre. Commentaire libre, pièce jointe possible.

Traitement dans le back-office : affectation, échanges, décision, clôture. Chaque étape tracée.

Un litige sur le montant donne accès, côté back-office, au **détail décomposé figé** et à la règle tarifaire figée sur la course (L4-01). C'est ce qui permet de trancher : sans ces éléments figés, un litige sur une course ancienne est inarbitrable.

Un litige de catégorie sécurité remonte au niveau d'alerte des incidents.

Délai de signalement limité après la course, configurable.

### Critères d'acceptation

1. Le signalement est possible depuis l'historique, dans le délai configuré.
2. Le back-office affiche le détail tarifaire figé pour un litige de montant.
3. Un litige sécurité produit une alerte.
4. Chaque étape de traitement est tracée avec son auteur.
5. Le délai de signalement est configurable.

---

## L8-06 — TLS partout

### Objectif

Aucune liaison en clair, y compris en recette.

### Fichiers

```
infra/caddy/Caddyfile
infra/compose.yaml
packages/api-client/src/http/client.ts
```

### Spécification

Caddy termine le TLS et redirige HTTP vers HTTPS sur les trois hôtes — `babana.cm`, `api.babana.cm`, `admin.babana.cm`. WebSocket compris.

En développement, certificat interne auto-signé, avec la procédure d'ajout au magasin de confiance documentée. **Ne pas désactiver la vérification de certificat dans les apps pour contourner** : une désactivation « temporaire » finit en production.

En production, certificat automatique par Caddy pour les trois hôtes. Le renouvellement exige que le port 80 reste joignable : ne pas le fermer au pare-feu, c'est la cause classique d'expiration silencieuse d'un certificat trois mois après la mise en service.

`admin.babana.cm` est en outre restreint par liste d'adresses autorisées, configurée par variable d'environnement pour pouvoir évoluer sans déploiement.

Les apps refusent toute connexion non chiffrée, en développement comme en production. Contrôle par configuration réseau de la plateforme, pas seulement par convention de code.

En-têtes de sécurité sur les réponses HTTP, y compris sur la page publique de partage de trajet.

### Critères d'acceptation

1. Une requête HTTP est redirigée vers HTTPS.
2. Le WebSocket n'est joignable qu'en chiffré.
3. Les apps refusent une connexion non chiffrée, dans tous les environnements.
4. La vérification de certificat n'est désactivée nulle part.
5. Les en-têtes de sécurité sont présents, page de partage comprise.
6. Les trois hôtes obtiennent et renouvellent leur certificat ; le port 80 reste joignable pour le renouvellement.
7. `admin.babana.cm` refuse une adresse hors liste.

---

## L8-07 — Chiffrement au repos

### Objectif

Protéger les données stockées (CDC §VII.2).

### Fichiers

```
infra/compose.yaml
docs/security/encryption.md
```

### Spécification

Chiffrement du volume PostgreSQL et du stockage d'objets. En production, chiffrement au niveau du volume fourni par l'hébergeur, avec gestion de clés documentée.

Les documents chauffeurs ne sont jamais servis en URL publique, seulement par accès signé à durée limitée (L1-05).

Aucun secret n'est stocké en clair en base : les jetons de renouvellement sont hachés, les codes OTP sont hachés.

Documenter ce qui est chiffré, ce qui ne l'est pas et pourquoi. Une documentation qui prétend que tout est chiffré alors que ce n'est pas le cas est pire que pas de documentation.

### Critères d'acceptation

1. Les volumes de données sont chiffrés en production.
2. Aucun objet n'est accessible sans URL signée.
3. Les jetons de renouvellement et les codes OTP sont stockés hachés.
4. La documentation est exacte, y compris sur ce qui n'est pas chiffré.

---

## L8-08 — Sauvegarde et restauration

### Objectif

Pouvoir restaurer, pas seulement sauvegarder.

### Contexte

**La tâche n'est pas finie quand la sauvegarde tourne, elle est finie quand une restauration a été effectuée avec succès sur un environnement vierge.** Une sauvegarde jamais restaurée n'est pas une sauvegarde.

### Fichiers

```
infra/backup/backup.sh
infra/backup/restore.sh
docs/operations/backup-restore.md
```

### Spécification

Sauvegarde quotidienne automatique de PostgreSQL et du stockage d'objets, vers un emplacement distinct de l'hôte de production.

Rétention par paliers : quotidiennes sur quelques semaines, hebdomadaires sur quelques mois.

**Redis n'est pas sauvegardé, par construction.** Le documenter explicitement dans la procédure, avec le renvoi à la règle de partition — sinon quelqu'un l'ajoutera par prudence et croira que l'état temps réel est durable.

Procédure de restauration écrite, exécutable par quelqu'un qui n'a pas développé le système, avec le temps de restauration attendu.

**Exercice de restauration** sur un environnement vierge, avec compte rendu daté versionné dans le dépôt. À refaire périodiquement.

Alerte si une sauvegarde échoue ou n'a pas eu lieu. Une sauvegarde silencieusement interrompue depuis trois semaines est le scénario classique.

### Critères d'acceptation

1. La sauvegarde tourne quotidiennement et sa réussite est vérifiée.
2. L'échec ou l'absence de sauvegarde déclenche une alerte.
3. La procédure de restauration est écrite et exécutable par un tiers.
4. **Un exercice de restauration a été réalisé**, avec compte rendu daté dans le dépôt.
5. L'absence de sauvegarde Redis est documentée et justifiée.

---

## L8-09 — Journalisation non modifiable

### Objectif

Pouvoir trancher un litige.

### Fichiers

```
services/odoo/addons/babana/models/babana_audit_log.py
services/odoo/addons/babana/tests/test_audit_log.py
```

### Spécification

Modèle `babana.audit.log` : horodatage, acteur, action, modèle et enregistrement concernés, valeurs avant et après, contexte technique.

Événements journalisés **obligatoirement** : chaque transition de course, chaque mouvement de compte courant, chaque remise et sa validation, chaque changement d'état de chauffeur, chaque ajustement, chaque accès à un document chauffeur.

**Immuable** : ni modification, ni suppression, y compris pour un administrateur. Interdit au niveau du modèle.

La journalisation ne doit **jamais** faire échouer l'opération métier : si l'écriture du journal échoue, l'opération se poursuit et l'échec est signalé séparément. Un journal qui bloque les courses serait désactivé le premier jour d'incident.

Purge après une durée de rétention définie, cohérente avec L8-10.

Vue back-office consultable et filtrable, réservée aux administrateurs.

### Critères d'acceptation

1. Chaque événement de la liste produit une entrée.
2. Une tentative de modification ou de suppression échoue, y compris en administrateur.
3. Un échec d'écriture du journal ne fait pas échouer l'opération métier.
4. Les valeurs avant et après sont exploitables pour reconstituer un historique.
5. La purge respecte la durée de rétention.

---

## L8-10 — Conservation des données de localisation

### Objectif

Définir et appliquer une politique de conservation (CDC §VII.4).

### Fichiers

```
services/odoo/addons/babana/models/babana_data_retention.py
services/odoo/addons/babana/data/cron_retention.xml
docs/compliance/data-retention.md
```

### Spécification

Durées de conservation à définir par catégorie, chacune justifiée :

| Donnée | Durée | Justification |
|---|---|---|
| Positions temps réel dans Redis | Minutes | Règle de partition |
| Tracé archivé d'une course | À définir | Litiges et incidents |
| Course, facture, mouvements de caisse | Durée légale comptable | Obligation |
| Documents chauffeur | Durée de la relation plus délai légal | Obligation |
| Journal d'audit | À définir | Litiges |

Purge automatique quotidienne. Le tracé peut être purgé sans supprimer la course : c'est la donnée la plus sensible et la moins nécessaire au long terme.

Procédure d'exercice des droits : accès, rectification, suppression, avec les limites qu'imposent les obligations comptables.

Documenter les durées **et leur justification**. Une durée sans justification ne résiste pas à un contrôle, et personne n'osera la modifier.

### Critères d'acceptation

1. Chaque catégorie a une durée et une justification écrite.
2. La purge automatique s'exécute et est idempotente.
3. Un tracé purgé ne supprime pas la course ni la facture.
4. La procédure d'exercice des droits est documentée.
5. Les obligations comptables priment sur une demande de suppression, et c'est écrit.
