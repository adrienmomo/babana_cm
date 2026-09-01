# 07 — Démonstration au client

**Établi le 5 septembre.** Objectif de la démonstration : rassurer sur l'avancement. Support
retenu : le VPS, en accès restreint.

---

## 1. Deux constats avant de préparer

Vérifiés dans le dépôt aujourd'hui, pas supposés.

**`make seed` ne fonctionne pas.** La cible du `Makefile` pointe sur
`services/odoo/scripts/seed.py`, et ce fichier n'existe pas — le répertoire non plus. La commande
figure dans la liste de `CLAUDE.md` depuis le premier jour et **n'a jamais été exécutée** : les
tests construisent chacun leurs propres données, donc personne n'en a eu besoin.

Autrement dit, **il n'existe aujourd'hui aucun jeu de données de démonstration**. Une base fraîche
donne un produit qui fonctionne et qui est vide : ni chauffeur, ni zone peuplée, ni historique. Ce
n'est pas montrable en l'état, et c'est exactement le genre de chose qui se découvre vingt minutes
avant un rendez-vous.

C'est aussi, une fois de plus, une commande qui a l'air de marcher parce qu'elle est écrite quelque
part.

**Caddy ne sert pas l'application web.** L'infrastructure route le domaine principal, l'API et le
back-office ; rien ne sert le bundle du Client. Le déployer demande un site de plus et une étape de
construction — c'est une part de L6-18, pas un réglage. Et c'est le montage en **même origine** que
D46 exige de toute façon.

---

## 2. Ce que la démonstration coûte, et ce qu'elle rapporte

Rien de ce qu'elle demande n'est du travail jetable. Les trois pièces manquantes sont au périmètre
pilote :

| À faire | Tâche | Serait à faire de toute façon |
|---|---|---|
| Le jeu de données de démonstration | L0-06 (jamais terminée) | Oui — les prérequis le nomment |
| Servir le bundle Client sous la même origine | Part de L6-18 | Oui, et c'est le montage de D46 |
| Déployer sur le VPS | L0-07 | Oui — au périmètre pilote |

**La démonstration ne détourne donc pas le calendrier, elle en tire une partie vers l'avant.** Un
soir de travail, et le déploiement cesse d'être une inconnue de fin de parcours.

**L'accès reste fermé.** Les habilitations (L8-01, L8-02) ne sont pas faites : rien ne garantit
aujourd'hui qu'un chauffeur ne lise pas les courses d'un autre. Le back-office a déjà une liste
d'adresses autorisées dans la configuration Caddy ; la même discipline s'applique au reste du
domaine tant que les habilitations n'existent pas. Une démonstration derrière un accès restreint,
oui. Une adresse publique, non.

---

## 3. Le scénario, dans l'ordre

Environ dix minutes. Deux écrans : le Client dans un navigateur, le back-office dans un autre
onglet. Le Chauffeur est piloté depuis un script ou un second navigateur — l'application Chauffeur
n'a pas d'export web (D22), et l'APK sur un vrai téléphone est plus parlant si vous en avez un sous
la main.

1. **Le client ouvre l'application.** La carte de Douala, sa position, et cinq chauffeurs autour de
   lui — réels, tenus à jour en direct.
2. **Il désigne son départ en glissant la carte** sous le réticule, puis son arrivée. Dire un mot
   ici : à Douala l'adresse formelle n'existe quasiment pas, la désignation par repère est le
   chemin principal, pas un raccourci.
3. **L'estimation s'affiche** avec son détail décomposé — prise en charge, distance, majoration. Le
   montant est vérifiable de tête, et c'est délibéré : sur un marché où l'on négocie à l'arrivée,
   un tarif qu'on peut recalculer est ce qui rend l'application crédible.
4. **Il choisit un chauffeur** parmi les cinq. Montrer que la liste continue de vivre pendant qu'il
   compare.
5. **Le chauffeur reçoit la proposition** avec son compte à rebours, et **refuse**. Le client
   revient à la sélection, ce chauffeur en moins — sans attribution automatique, c'est une décision
   de maîtrise d'ouvrage assumée.
6. **Un second chauffeur accepte.** Le client voit son immatriculation, sa gamme, et sa position
   qui se rapproche.
7. **Course démarrée, terminée, encaissée.** Le résumé de fin s'affiche.
8. **Bascule au back-office** : la course avec son tarif appliqué, le compte courant du chauffeur
   qui a monté du montant encaissé, et l'écriture comptable de la remise si vous en jouez une.

Le point 8 est celui qui impressionne le plus, et c'est aussi le moins spectaculaire à l'écran :
c'est là qu'on voit que ce n'est pas une maquette.

---

## 4. Ce qu'il faut dire, et ne pas laisser croire

Une démonstration qui laisse croire à un produit fini prépare une conversation difficile trois
semaines plus tard. Trois phrases suffisent.

**« Un chauffeur ne peut pas encore s'inscrire lui-même. »** Le dépôt des pièces demande une
bibliothèque native qui arrive avec le prochain build. Aujourd'hui les chauffeurs sont créés au
back-office — ce qui, pour une démonstration, se montre mieux.

**« L'application Chauffeur doit rester ouverte. »** Les notifications sont en cours ; sans elles,
une application fermée ne reçoit pas de proposition.

**« Les écritures comptables sont plausibles et pas encore justes. »** Le plan comptable de
démonstration n'est pas le SYSCOHADA. Les comptes sont paramétrables et attendent la validation
d'un comptable. Le dire vous-même vaut mieux que de le laisser découvrir.

Et une quatrième, si la question du calendrier vient : **premières courses visées au 13 octobre,
marge au 20**. Le détail est dans `06-jalons-et-pilote.md`, avec ce qui pourrait le compresser et
ce qui le ferait glisser.

---

## 5. Le point d'étape chiffré

À dire ou à laisser dans un document, selon le registre du rendez-vous.

**61 % du développement**, mesuré sur cent vingt-deux tâches pondérées, dérivé du dépôt et non
d'une impression. Le parcours d'une course fonctionne de bout en bout, des deux côtés,
encaissement et comptabilité compris.

**Ce qui reste**, en clair : l'inscription des chauffeurs, les notifications, les habilitations, le
back-office de supervision, le mode dégradé réseau, et le déploiement.

**Ce qui ne dépend pas de nous** et qu'il faut nommer devant lui, parce que ce sont les seuls
délais que le travail ne rattrape pas : la passerelle SMS — un fournisseur à choisir, qui bloque
l'inscription par OTP — la validation du plan comptable, et la vérification développeur Android.

---

## 6. Une répétition avant le rendez-vous

Les quatre dernières nuits ont chacune trouvé un défaut réel à la seconde où quelqu'un a ouvert un
navigateur. Quelqu'un d'extérieur qui manipule en trouvera un autre.

Jouer le scénario une fois, en entier, la veille — pas le matin même. C'est une vérification de
plus, et c'est la seule qui se fasse dans les conditions du rendez-vous.
