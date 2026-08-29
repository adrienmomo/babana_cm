# 06 — Jalons et date de pilote

**Établi le 31 août 2026, après vingt-trois nuits.** Ce document existe parce que la question est
devenue répondable : il y a trois semaines, « quand le pilote ? » n'avait pas de réponse honnête.
Aujourd'hui ce qui reste est énumérable.

---

## 1. Où nous en sommes

**121 tâches, 234 points de charge. 69 tâches faites, 131 points — 56 %.**

La mesure est pondérée (S = 1, M = 2, L = 3) et dérivée du dépôt, pas d'une impression : une tâche
est comptée faite quand un commit ou un rapport de nuit la nomme. Elle sous-estime légèrement — une
poignée de tâches anciennes échappent à la détection — mais l'ordre de grandeur tient.

**Le rythme réel est de cinq points par nuit**, stable sur les six dernières. Il ne remontera pas :
chaque tâche coûte désormais plus de lecture que la précédente, et c'est la règle inscrite dans
`CLAUDE.md` depuis le 15 août.

Cent trois points restent. À cinq points la nuit, **vingt nuits pour tout finir.**

Mais tout finir n'est pas la question.

---

## 2. Ce qu'un pilote exige vraiment

C'est ici que se joue la date. Sur les 103 points restants, **environ 60 sont nécessaires à un
pilote avec de vrais chauffeurs et de vrais passagers.** Le reste peut attendre — et une partie ne
peut même pas se faire avant, parce qu'elle se calibre sur les données du pilote lui-même.

### Nécessaire, sans discussion

| Quoi | Pourquoi ça ne peut pas attendre |
|---|---|
| **L6-05** capture GPS chauffeur | Sans elle, aucun suivi. Et c'est la tâche qui décide si un chauffeur garde l'application : batterie |
| **L3-10** accumulation distance/durée | Sans elle, une course se termine sur des valeurs inventées |
| **L6-15** inscription et documents chauffeur | Aujourd'hui, aucun chemin ne permet à un vrai chauffeur d'entrer dans le système |
| **L5-07** écran de recette | Un chauffeur qui ne voit pas ce qu'il doit ne peut pas le remettre |
| **L6-16** mode dégradé réseau | Le réseau intermittent est le cas courant à Douala, pas l'exception |
| **L7-01, L7-04** notifications push | Un chauffeur dont l'app est fermée ne reçoit aucune proposition. Sans push, le pilote ne fonctionne pas |
| **L8-01, L8-02** habilitations | Un chauffeur ne doit pas lire les courses d'un autre. Non négociable avant de laisser entrer des tiers |
| **L8-08** sauvegardes | Avec restauration testée. Une sauvegarde jamais restaurée n'est pas une sauvegarde |
| **L0-07** déploiement | Le produit tourne aujourd'hui sur une machine de développement |
| **L9-01 à L9-05** back-office | Un superviseur doit valider les chauffeurs et suivre les courses |
| **L3-12** file de rejeu | Le dernier chemin sans filet : un refus perdu bloque une course pour toujours |
| **L10-01** scénarios de bout en bout | La suite qui protège tout le reste |
| **L1-09** OTP téléphone | Dépend de la passerelle SMS, voir §3 |
| **L4-06, L4-08** facture | Une course encaissée sans facture est un problème comptable dès le premier jour |

**Environ 60 points. Douze nuits.**

### Peut attendre, et pourquoi

- **L6-18** export web — c'est une démonstration, pas le canal du pilote.
- **L6-10** historique et factures dans l'app — consultables au back-office en attendant.
- **L2-06, L2-07** promotions — il n'y en aura pas au pilote.
- **L9-07, L9-09, L9-10** analyses — elles ont besoin de données que le pilote produira.
- **L10-02 à L10-08** — pour l'essentiel de la **calibration** : ETA, seuils, tarifs réels. Ces
  tâches ne peuvent pas précéder le pilote, elles le suivent. C'est leur nature, pas un report.
- **L6-17** mesure batterie — se fait **pendant** le pilote, sur de vrais terminaux.

### La mesure batterie, et ce que « pendant le pilote » doit vouloir dire

Décidé le 2 septembre : L6-05 sera écrite sans mesure préalable sur un vrai téléphone, et le coût réel sera relevé au pilote. C'est un choix défendable — mais il ne devient un plan qu'à trois conditions, sans lesquelles il n'est qu'un report.

**La mesure se fait le premier jour, pas quand on y pensera.** Un chauffeur qui désinstalle au bout d'une semaine ne revient pas, et on ne saura même pas pourquoi. Une demi-journée d'observation sur deux ou trois terminaux, dès les premières courses.

**Tous les réglages de capture sont paramétrables** (invariant 5) : fréquences, seuils de vitesse, taille des lots, périodicité d'envoi. Si la batterie ne tient pas, la réponse doit être un changement de valeurs le soir même, jamais une réécriture.

**Un repli est prévu d'avance.** Le plus économe : ne capturer qu'en course, et se contenter d'une position rare hors course. On perd la fraîcheur du géo-index, on garde la flotte. Décider ce repli maintenant coûte dix minutes ; le décider en urgence avec des chauffeurs qui désinstallent coûte le pilote.

### Le protocole de mesure — une demi-journée, avant tout le reste

Ajouté le 3 septembre. Cette mesure conditionne une décision d'architecture (§4 bis de
`01-architecture.md`) et elle doit être faite **avant** la fin du développement, pas au premier jour
du pilote : si la capture ne tient pas en arrière-plan, la réponse est une bibliothèque native et
un nouveau build, ce qui ne s'improvise pas la veille.

**Ce qu'on cherche** : est-ce qu'Android suspend la capture quand l'application passe derrière
Google Maps ? C'est le chemin normal de chaque course (D12), pas un cas limite.

**Comment.** Installer l'APK Chauffeur, se mettre en ligne, faire une course réelle ou simulée en
navigant avec Google Maps pendant vingt minutes écran allumé. Puis compter, **côté serveur**, les
positions réellement arrivées sur cette période — le nombre attendu se déduit de la cadence
configurée. Refaire l'exercice écran éteint, téléphone en poche, quinze minutes, en ligne mais
hors course : c'est l'état où le chauffeur passe le plus de temps.

**Sur deux ou trois téléphones différents**, dont au moins un Xiaomi ou un Huawei : leurs
politiques d'économie de batterie sont plus agressives que l'Android standard, et un résultat sur
un seul appareil ne dit rien du parc réel.

**Ce qu'on relève en même temps, puisque le téléphone est là** : pourcentage de batterie consommé
sur la période, et données échangées. Les compteurs sont déjà posés dans l'application (L6-05,
`getMetrics()`).

**Ce que chaque issue déclenche** — décidé d'avance pour que la mesure serve immédiatement :

| Résultat | Décision |
|---|---|
| La capture tient sur tous les appareils | Rien à faire. Une dépendance native et un lot évités |
| Elle tient mal, ou seulement sur certains | Bibliothèque de service de premier plan — elle couvre l'attente **et** la course |
| Elle ne tient pas du tout | Alors seulement, rouvrir la navigation embarquée — qui ne réglera toujours que la course |

---

## 3. Les trois délais subis, et ils commandent tout

Aucune nuit de travail ne les rattrapera. Ils courent en parallèle du développement **s'ils sont
lancés**, et deviennent le chemin critique s'ils ne le sont pas.

| Démarche | Nature du délai | Ce qu'elle bloque |
|---|---|---|
| **Vérification développeur Android** | Validation d'identité, quelques jours | L'installation sur un appareil certifié, à terme. Distincte du compte Play |
| **Passerelle SMS** | Contractualisation locale, jours à semaines | L1-09 (OTP) **et** la notification du contact d'urgence — un fournisseur, deux usages |
| **Validation du plan comptable** | Disponibilité d'un tiers | Rien techniquement — mais tant qu'elle n'est pas faite, les écritures produites sont **plausibles et fausses**, et ça se découvre au premier audit |

**La passerelle SMS est la plus longue et la moins prévisible**, parce qu'elle demande de choisir
un fournisseur et de contractualiser. C'est elle qui fixe la date si elle n'est pas lancée
maintenant.

À lancer aussi, mais courts (heures à jours) : VPS, DNS, projet Google Cloud et clé Maps, projet
Firebase.

---

## 4. La date

En partant du 31 août, à cinq points par nuit et sans interruption :

| Jalon | Date visée | Ce qui doit être vrai |
|---|---|---|
| **Périmètre pilote terminé** | ~15 septembre | Les 60 points. Douze nuits |
| **Déploiement et recette** | ~22 septembre | Sur le VPS réel, avec de vrais comptes externes, données de pilote chargées |
| **Pilote — premières courses** | **~29 septembre**, avec une marge au **6 octobre** | Chauffeurs inscrits et validés, superviseur formé, sauvegardes testées |

**La marge d'une semaine n'est pas de la prudence rituelle.** Les dix dernières nuits ont toutes
trouvé un défaut réel que rien n'aurait révélé autrement — une écriture comptable qui contredisait
le compte courant, un jeton en clair en base, une commande de course qui échouait au premier appel
réel. Il n'y a aucune raison que les douze prochaines fassent exception, et c'est une bonne
nouvelle : ces défauts sont trouvés maintenant plutôt qu'en pilote.

---

## 5. Ce qui ferait glisser la date

Par ordre de probabilité décroissante.

**La passerelle SMS non lancée cette semaine.** C'est le seul délai que le développement ne peut
pas absorber, et il bloque l'entrée des chauffeurs dans le système (OTP).

**Le lot L8 (habilitations).** `CLAUDE.md` le place sous revue humaine obligatoire, et pour une
bonne raison : une matrice d'habilitations fausse produit des tests verts qui valident les
mauvaises règles. Il faut compter une matinée de relecture, pas une heure.

**La mesure batterie (L6-17).** Si la capture GPS vide une batterie d'entrée de gamme en trois
heures, ce n'est pas un réglage : c'est une reprise de L6-05. Le risque se mesure tôt, sur un vrai
terminal, pas au moment de le découvrir.

**Le plan comptable.** Il ne bloque pas le code, il bloque la conformité — et il se découvre tard,
ce qui est précisément le pire moment.

---

## 6. Ce que je recommande de faire cette semaine

Rien de ce qui suit ne demande plus d'une heure, et tout est à délai subi.

0. **Mesurer la capture GPS en arrière-plan** — une demi-journée, protocole au §2. C'est la seule
   donnée qui manque pour trancher une décision d'architecture, et elle ne s'obtient nulle part
   ailleurs qu'avec un vrai téléphone.
1. **Lancer la vérification développeur Android** — c'est la démarche, plutôt que le compte Play.
2. **Choisir et contacter une passerelle SMS.** Un fournisseur, deux usages.
3. **Trouver le comptable** qui validera le plan, et lui poser les trois questions déjà écrites
   (`05-prerequis-et-simulation.md` §5), dont la TVA.
4. **Provisionner le VPS et pointer le DNS.**

Les trois premières sont des décisions qui n'appartiennent qu'à vous. La quatrième peut se faire à
n'importe quel moment, mais elle conditionne la recette du 22 septembre.
