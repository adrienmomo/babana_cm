# L1 — Identité, comptes, flotte

Décisions structurantes : D4 (Google Sign-In seul), D5 (chauffeurs salariés), D6 (motos de l'entreprise). Écarts É1 et É2.

---

## L1-01 — Contrôleur d'authentification Google

### Objectif

Échanger un ID token Google contre une identité Odoo vérifiée.

### Contexte

**C'est la tâche qui valide ou invalide D4.** Le endpoint natif `/web/session/authenticate` attend `db / login / password` : aucun mécanisme Odoo standard n'accepte un jeton Google. Ce contrôleur est donc inévitable, et c'est lui qui justifie l'existence du module custom.

### Fichiers

```
services/odoo/addons/babana/controllers/auth.py
services/odoo/addons/babana/models/res_users.py
services/odoo/addons/babana/tests/test_auth.py
```

### Spécification

`POST /api/v1/auth/google`, corps `{ idToken, role }` où `role` vaut `client` ou `driver`. Le contrat C-01 fait foi sur la casse des champs (D17).

Vérifications, **toutes obligatoires**, dans cet ordre :

1. Signature du jeton, contre les clés publiques Google récupérées depuis l'endpoint JWKS de Google, **mises en cache et rafraîchies** selon les en-têtes de cache — ne pas les récupérer à chaque appel, ne pas les figer non plus.
2. `iss` vaut `accounts.google.com` ou `https://accounts.google.com`.
3. `aud` appartient à la liste blanche `GOOGLE_OAUTH_CLIENT_IDS`.
4. `exp` n'est pas dépassé, avec une tolérance d'horloge de quelques secondes au plus.
5. `email_verified` est vrai.

Si toutes passent : rechercher un `res.users` par `sub` Google. S'il existe, le reprendre. Sinon, créer l'utilisateur avec le `sub` comme identifiant stable — **jamais l'email**, qui peut changer.

Selon `role`, créer ou rattacher le `babana.driver` ou le partenaire client correspondant.

**Un sign-in chauffeur ne crée jamais de fiche `hr.employee`** (correction du 13 août). Il crée une **candidature** : un `babana.driver` à l'état `pending`, sans rattachement salarié. C'est L1-06, la validation du dossier par un gestionnaire, qui crée ou rattache la fiche RH.

La raison est une faille, pas une préférence : sans cette règle, n'importe quel compte Google appelant `/auth/google` avec `role=driver` fait naître une fiche employé dans le module RH. Les fiches restent `pending` et inoffensives sur le plan métier, mais elles polluent la base et offrent un vecteur de spam. Aucune écriture dans `hr` ne doit résulter d'une action non validée par un humain.

C'est aussi ce que décrit le CDC §IV.1 : le chauffeur crée son compte, téléverse ses documents, et **un administrateur valide avant activation**. D5 (salariat) ne change pas ce tunnel d'entrée, il change ce qui se passe à la validation.

**Limitation de débit** sur la création de candidature, par adresse et par compte. Une auto-inscription ouverte sans plafond est un vecteur d'abus, même quand chaque compte créé est inerte.

Réponse : jeton applicatif, jeton de renouvellement, profil minimal, et pour un chauffeur, son statut de validation.

Un chauffeur dont le dossier n'est pas approuvé **reçoit tout de même un jeton**, avec un statut explicite : il doit pouvoir se connecter pour suivre l'avancement de son dossier et téléverser des pièces manquantes. Ce sont les endpoints métier qui refuseront ses actions, pas l'authentification.

### Critères d'acceptation

1. Un jeton valide crée l'utilisateur au premier appel, le reprend au second.
2. Un jeton dont la signature est invalide est rejeté.
3. Un jeton dont `aud` n'est pas dans la liste blanche est rejeté — **test explicite obligatoire**, c'est la vulnérabilité classique de cette intégration.
4. Un jeton expiré est rejeté.
5. Un jeton avec `email_verified` faux est rejeté.
6. Un changement d'email chez Google ne crée pas de doublon : l'utilisateur est retrouvé par `sub`.
7. Les clés Google sont mises en cache : un second appel dans la fenêtre de cache ne déclenche pas de requête sortante.
8. Un chauffeur non approuvé obtient un jeton et un statut `pending`.
9. **Aucun `hr.employee` n'est créé par l'authentification** — test explicite : après un premier sign-in `role=driver`, le nombre de fiches employé est inchangé.
10. La création de candidature est soumise à une limitation de débit.

### Piège

La vérification doit être **serveur**. Toute variante qui fait confiance à une information transmise par le client sans vérifier la signature — l'email, le `sub`, un champ « déjà vérifié côté app » — ouvre l'usurpation de compte complète. Ne jamais décoder le jeton sans vérifier sa signature, même « juste pour lire le sub ».

---

## L1-02 — Jetons applicatifs

### Objectif

Émettre, renouveler et révoquer les jetons qui authentifient les appels mobiles et les connexions WebSocket.

### Fichiers

```
services/odoo/addons/babana/models/babana_token.py
services/odoo/addons/babana/controllers/auth.py
services/odoo/addons/babana/tests/test_token.py
```

### Spécification

Jeton d'accès signé, de courte durée — de l'ordre de l'heure. **La charge utile est celle de `AccessTokenClaimsSchema` (C-01), pas une forme choisie ici** : `sub`, `role`, `driverId` sur un jeton chauffeur, `iat`, `exp`, `jti`. Le contrôleur construit ses claims depuis le schéma partagé et non depuis un dictionnaire écrit à la main — deux implémentations lisent ce jeton, une seule le déclare (D23).

Jeton de renouvellement, longue durée, **stocké côté serveur** pour être révocable. Un chauffeur suspendu doit perdre l'accès immédiatement, ce qu'un jeton entièrement autoportant ne permet pas.

Rotation à chaque renouvellement : le jeton de renouvellement utilisé est invalidé et remplacé. La réutilisation d'un jeton de renouvellement déjà consommé révoque **toute la famille** de jetons — c'est le signe d'un vol.

**Avec une fenêtre de grâce (D36, 22 août).** La règle ci-dessus suppose un réseau qui livre ou qui échoue franchement. Celui de Douala ne fait ni l'un ni l'autre : une coupure entre l'envoi du jeton et la réception de son remplaçant laisse l'ancien consommé côté serveur et aucun nouveau côté téléphone. L'application présente alors le seul jeton qu'elle possède, et se fait révoquer toute sa famille — un chauffeur déconnecté en pleine journée, sans comprendre pourquoi, et un événement qui ressemble à un vol dans les journaux.

Un jeton consommé depuis moins d'une fenêtre configurable **renvoie donc le même couple qu'à son premier usage**, sans rien révoquer et sans créer de nouveau jeton. C'est l'idempotence des écritures appliquée à l'authentification : rejouer une opération dont on n'a pas reçu la réponse doit redonner la réponse, pas punir. Au-delà de la fenêtre, la réutilisation redevient ce qu'elle est censée signaler.

Le couple rejoué est celui déjà émis, jamais un nouveau : sinon deux appareils repartiraient avec deux familles vivantes issues du même jeton, ce qui est précisément ce que la rotation cherche à rendre impossible.

Le service temps réel valide le jeton d'accès localement avec le secret partagé, sans appel à Odoo : un appel sortant par connexion WebSocket ne passerait pas à l'échelle.

### Critères d'acceptation

1. Un jeton expiré est refusé avec `TOKEN_EXPIRED`.
2. Le renouvellement produit un nouveau couple et invalide l'ancien jeton de renouvellement.
3. La réutilisation d'un jeton de renouvellement consommé **au-delà de la fenêtre de grâce** révoque toute la famille.
3 bis. **Dans la fenêtre, la réutilisation renvoie le même couple qu'au premier usage** — ni révocation, ni troisième jeton émis. Testé aux deux bornes : juste avant, juste après.
4. La suspension d'un chauffeur invalide ses jetons de renouvellement ; il perd l'accès au plus tard à l'expiration de son jeton d'accès courant.
5. Le service temps réel valide un jeton sans appeler Odoo.
6. **Un jeton réellement émis par `/auth/google` valide contre `AccessTokenClaimsSchema`** — le test lit le jeton produit, il ne vérifie pas la forme qu'il aurait voulu produire.
7. **Le jeton d'un chauffeur porte `driverId`, et cet identifiant est celui de `babana.driver.public_id`, jamais celui de `sub`.** Deux modèles Odoo distincts : les confondre affecte une connexion au mauvais chauffeur.

---

## L1-03 — Modèle `babana.driver`

### Objectif

Le chauffeur salarié, avec son état opérationnel et son compte courant.

### Contexte

D5 : chauffeur salarié, donc rattaché à `hr.employee`. É3 : commission et abonnement sont hors périmètre v1, mais **le modèle ne doit pas rendre leur ajout coûteux** — à vérifier en revue.

### Fichiers

```
services/odoo/addons/babana/models/babana_driver.py
services/odoo/addons/babana/security/ir.model.access.csv
services/odoo/addons/babana/tests/test_driver.py
```

### Spécification

Champs principaux :

| Champ | Type | Rôle |
|---|---|---|
| `employee_id` | Many2one `hr.employee`, **facultatif tant que `state` vaut `pending`** | Rattachement salarié (D5), créé ou relié par L1-06 à l'approbation |
| `user_id` | Many2one `res.users` | Compte de connexion |
| `state` | Sélection | `pending`, `approved`, `rejected`, `suspended` |
| `rejection_reason` | Texte | Motif, obligatoire si `rejected` |
| `is_online` | Booléen | Disponibilité (D7) |
| `rating_avg` | Flottant, calculé | Note moyenne |
| `rating_count` | Entier, calculé | Nombre d'avis |
| `ride_count` | Entier, calculé | Indicateur d'équité (C2c, L9-08) |
| `cash_balance` | Monétaire | Solde dû à l'entreprise (D8) |
| `cash_limit` | Monétaire | Plafond d'encaisse, hérité d'un défaut de configuration |
| `phone_verified` | Booléen | Résultat de L1-09 |
| `motorcycle_id` | Many2one `babana.motorcycle` | Affectation courante. **Ajouté par L1-07** — un `Many2one` vers un modèle absent empêche l'installation |

Contraintes : `is_online` ne peut passer à vrai que si `state` vaut `approved`. **`employee_id` est obligatoire dès que `state` vaut `approved`** — un chauffeur approuvé est un salarié, une candidature ne l'est pas encore. La contrainte porte sur l'état, pas sur la création. `cash_balance` ne peut jamais être négatif — un solde négatif signale une erreur de calcul, pas un cas métier.

`cash_balance` n'est **jamais** écrit directement : il est le résultat des mouvements enregistrés en L5-01. Le rendre calculé à partir du journal des mouvements, pas stocké librement.

### Critères d'acceptation

1. Un chauffeur `pending` ne peut pas passer `is_online` à vrai.
2. Un chauffeur suspendu passe automatiquement hors ligne.
3. `rating_avg` se recalcule à chaque nouvel avis. **Vérifiable seulement après L4-09** ; jusque-là, le champ est un pont tracé (voir `CLAUDE.md`, conventions).
4. Une tentative d'écriture directe de `cash_balance` échoue.
5. Revue : l'ajout ultérieur d'un solde de commission ou d'un abonnement ne demanderait pas de migration structurelle (É3).
6. Tout champ transitoire est inscrit dans `docs/bridge-fields.md` et porte la mention `[PONT]` dans son `help`.
7. **L1-03 supprime les champs-pont posés sur `res.users` par L1-01** (`babana_role`, `babana_driver_state`) : le statut du chauffeur vient désormais de `babana.driver`, pas d'une copie sur l'utilisateur.

---

## L1-04 — Modèle client

### Objectif

Le passager, sur `res.partner`.

### Fichiers

```
services/odoo/addons/babana/models/res_partner.py
services/odoo/addons/babana/tests/test_partner.py
```

### Spécification

Étendre `res.partner` : `babana_is_customer`, `babana_google_sub`, `babana_phone_verified`, `babana_rides_count`, `babana_emergency_contact`.

Ne pas créer un modèle client séparé : la facturation Odoo (`account.move`, L4-06) attend un `res.partner`. Un modèle parallèle imposerait une synchronisation qui dérivera.

Le contact d'urgence sert au partage de trajet (L8-03).

### Critères d'acceptation

1. Un client créé par L1-01 est un `res.partner` avec `babana_is_customer` vrai.
2. `babana_google_sub` est unique.
3. Une facture peut être émise à ce partenaire sans traitement particulier.

---

## L1-05 — Documents chauffeur

### Objectif

Téléverser permis et pièce d'identité, avec accès signé à durée limitée.

### Contexte

É2 : la carte grise n'est **pas** téléversée par le chauffeur — elle appartient à la flotte (L1-07). Seuls le permis et la pièce d'identité sont demandés.

### Fichiers

```
services/odoo/addons/babana/models/babana_driver_document.py
services/odoo/addons/babana/services/storage.py
services/odoo/addons/babana/controllers/documents.py
services/odoo/addons/babana/tests/test_documents.py
```

### Spécification

Modèle `babana.driver.document` : chauffeur, type (`license`, `id_card`), clé de stockage, date d'expiration, statut de vérification, motif de rejet.

Stockage sur S3 via `services/storage.py`. **Aucun objet n'est public.** La lecture passe par une URL signée d'une durée de quelques minutes, générée à la demande, et uniquement pour un utilisateur habilité — le chauffeur pour ses propres documents, un gestionnaire pour tous.

Le téléversement passe par le serveur, qui valide le type MIME réel — pas seulement l'extension — et la taille avant d'écrire.

Une URL signée générée pour un gestionnaire ne doit pas rester valide au-delà de sa fenêtre, même si elle est partagée.

### Critères d'acceptation

1. Un objet stocké n'est pas accessible sans URL signée. Vérifié par un appel direct qui échoue.
2. Une URL signée expire, et l'expiration est testée en avançant l'horloge.
3. Un chauffeur ne peut pas obtenir d'URL signée pour le document d'un autre chauffeur.
4. Un fichier dont le type MIME réel ne correspond pas au type déclaré est rejeté.
5. La date d'expiration du permis est obligatoire.

---

## L1-06 — Validation du dossier chauffeur

### Objectif

Accepter, rejeter ou suspendre un chauffeur depuis le back-office.

### Fichiers

```
services/odoo/addons/babana/models/babana_driver.py
services/odoo/addons/babana/views/babana_driver_views.xml
services/odoo/addons/babana/tests/test_driver_approval.py
```

### Spécification

Actions réservées à `group_babana_manager` :

- **Approuver** — impossible si un document requis manque ou n'est pas vérifié, ou si aucune moto n'est affectée. La contrainte est explicite : un chauffeur approuvé sans moto ne peut pas travailler, autant le dire à l'approbation.

  **L'approbation crée ou rattache la fiche `hr.employee`** (correction du 13 août). Le gestionnaire choisit : relier la candidature à une fiche existante — cas normal quand le chauffeur a été embauché avant de s'inscrire — ou en créer une. C'est le seul endroit du système où une écriture dans le module RH a lieu, et elle résulte toujours d'une décision humaine explicite.

  Ce que cette tâche **ne** tranche pas : comment le service RH complète ensuite la fiche — contrat, matricule, paie. Hors périmètre applicatif, mais à ne pas laisser en angle mort côté organisation.
- **Rejeter** — motif obligatoire, transmis au chauffeur.
- **Suspendre** — motif obligatoire ; passe le chauffeur hors ligne immédiatement et révoque ses jetons (L1-02). Une course en cours n'est **pas** interrompue : le passager est prioritaire sur la sanction.
- **Réactiver** — depuis `suspended` uniquement.

Chaque changement d'état est journalisé dans le fil de discussion Odoo, avec l'auteur et le motif.

### Critères d'acceptation

1. Approuver sans document vérifié échoue avec un message explicite.
1 bis. L'approbation crée ou rattache une fiche `hr.employee`, au choix du gestionnaire, et c'est la **seule** écriture dans `hr` de tout le système.
1 ter. Approuver sans fiche RH ni création est impossible : `employee_id` est obligatoire à l'état `approved`.
2. Approuver sans moto affectée échoue.
3. Rejeter sans motif échoue.
4. Suspendre passe hors ligne et révoque les jetons.
5. Suspendre un chauffeur en course ne l'interrompt pas ; il ne peut simplement plus en accepter de nouvelle.
6. Tout changement d'état apparaît dans le fil avec auteur et motif.

---

## L1-07 — Modèle `babana.motorcycle` et flotte

### Objectif

La flotte de l'entreprise (D6).

### Fichiers

```
services/odoo/addons/babana/models/babana_motorcycle.py
services/odoo/addons/babana/views/babana_motorcycle_views.xml
services/odoo/addons/babana/tests/test_motorcycle.py
```

### Spécification

Champs : immatriculation (unique), marque, modèle, année, gamme (`standard` ou `premium`, cf. CDC §II.2), référence de carte grise et document associé, assureur, numéro de police, date d'expiration d'assurance, état (`available`, `assigned`, `maintenance`, `retired`), chauffeur affecté.

La gamme alimente le choix du client en L6-07.

Contrainte : une moto dont l'assurance est expirée ne peut pas être affectée, et si elle l'est déjà, le chauffeur ne peut pas passer en ligne. Rouler sans assurance est un risque juridique que le système doit rendre impossible, pas seulement signaler.

### Critères d'acceptation

1. L'immatriculation est unique.
2. Une moto à l'assurance expirée ne peut pas être affectée.
3. Un chauffeur dont la moto a une assurance expirée ne peut pas passer en ligne.
4. L'état suit l'affectation automatiquement.

---

## L1-08 — Affectation moto ↔ chauffeur

### Objectif

Affectation durable, avec historique.

### Contexte

D6 et D7 combinés : l'affectation est durable, gérée par l'admin, et non liée à une prise de service — puisqu'il n'y a pas de prise de service.

### Fichiers

```
services/odoo/addons/babana/models/babana_assignment.py
services/odoo/addons/babana/tests/test_assignment.py
```

### Spécification

Modèle `babana.assignment` : moto, chauffeur, date de début, date de fin, auteur. La fin d'une affectation en ouvre potentiellement une autre.

Contraintes : une moto a au plus une affectation active ; un chauffeur a au plus une moto active. Les périodes ne se chevauchent pas.

L'historique n'est jamais modifié ni supprimé — il sert en cas de litige ou d'accident, où il faut savoir qui conduisait quoi et quand.

### Critères d'acceptation

1. Affecter une moto déjà affectée échoue.
2. Affecter une seconde moto à un chauffeur échoue.
3. Clore une affectation puis en créer une nouvelle fonctionne, et les deux restent dans l'historique.
4. Une affectation close ne peut plus être modifiée.

---

## L1-09 — Vérification du numéro par OTP

### Objectif

Vérifier le numéro de téléphone **une seule fois dans la vie du compte**, au rattachement.

### Contexte

É1 : Google Sign-In ne fournit pas de numéro vérifié. Le numéro est indispensable — le chauffeur doit joindre le client, et le Mobile Money de la phase 2 en dépendra. Un OTP unique par compte, pas à chaque connexion.

**Peut être repoussé après J3, mais pas après J4.** Sans numéro vérifié, la phase 2 hérite d'une base de numéros non fiables.

### Fichiers

```
services/odoo/addons/babana/models/babana_phone_verification.py
services/odoo/addons/babana/services/sms.py
services/odoo/addons/babana/controllers/phone.py
services/odoo/addons/babana/tests/test_phone_verification.py
```

### Spécification

`POST /phone/verify/start` : numéro au format international. Génère un code numérique, le stocke **haché**, l'envoie par SMS. Durée de vie courte, de l'ordre de dix minutes.

`POST /phone/verify/confirm` : numéro et code. En cas de succès, marque le numéro vérifié et supprime la vérification en cours.

Protections, toutes obligatoires :

- Nombre de tentatives limité par vérification ; au-delà, la vérification est annulée et il faut recommencer.
- Nombre de demandes limité par numéro et par heure, et par compte et par heure.
- Un numéro déjà vérifié sur un autre compte est refusé avec `PHONE_ALREADY_VERIFIED` — deux comptes ne partagent pas un numéro, sinon le rattachement Mobile Money devient ambigu.
- Le code n'est jamais renvoyé dans une réponse d'API, ni journalisé en production.

`services/sms.py` est une abstraction avec deux implémentations : passerelle réelle, et une implémentation de développement qui écrit le code dans les journaux.

### Critères d'acceptation

1. Un code correct vérifie le numéro.
2. Un code incorrect échoue ; au-delà de la limite de tentatives, la vérification est annulée.
3. Un code expiré échoue.
4. La limite de demandes par heure est appliquée.
5. Un numéro déjà vérifié ailleurs est refusé.
6. Le code n'apparaît jamais dans une réponse d'API.
7. En développement, le code apparaît dans les journaux et permet de terminer le parcours sans passerelle réelle.

---

## L1-10 — Alertes d'échéance

### Objectif

Prévenir avant l'expiration d'une assurance ou d'un permis.

### Fichiers

```
services/odoo/addons/babana/models/babana_motorcycle.py
services/odoo/addons/babana/data/cron.xml
services/odoo/addons/babana/tests/test_expiry_alerts.py
```

### Spécification

Tâche planifiée quotidienne. Détecte les échéances d'assurance de moto et de permis de chauffeur à venir dans un délai configurable, et le jour de l'expiration.

À l'expiration : la moto passe dans un état qui empêche l'affectation, et le chauffeur concerné est mis hors ligne. Le blocage est automatique, pas laissé à la vigilance d'un gestionnaire.

Notification aux gestionnaires par le fil Odoo. Vue back-office listant les échéances à venir.

### Critères d'acceptation

1. Une échéance dans la fenêtre d'alerte produit une notification.
2. Une assurance expirée bloque l'affectation et met le chauffeur hors ligne.
3. Un permis expiré met le chauffeur hors ligne.
4. La tâche est idempotente : deux exécutions le même jour ne produisent pas deux notifications.
