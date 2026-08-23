# Prompt de lancement — session de nuit J20

**Objectif** : refermer les trous que la cartographie a rendus visibles.

---

## À faire avant de lancer

```bash
cd /Users/adrien/workspace/babana.cm
git add -A
git commit -m "amoa: débrief J19, D43 pas de défaut vers le vrai fournisseur, D44 état réparé complet, L4-12"
```

---

## Le prompt

```
Tu travailles sur babana.cm. Le répertoire courant est la racine du projet.

Lis `CLAUDE.md` en entier, puis `amoa/questions/REPONSES-2026-08-28.md`.

Ta cartographie a trouvé, en une nuit, un trou que j'aurais découvert dans trois
semaines à trois heures du matin. C'est elle qui donne le périmètre de ce soir.

## Périmètre de cette session

**Correctifs d'abord.**

1. **La recherche de lieu** (D43) — la cause probable que tu as identifiée
   (deux exemplaires du module dans le bundle), **et** la règle qui l'a rendue
   invisible : aucune configuration de fournisseur externe n'a de valeur par
   défaut qui pointe vers le vrai fournisseur. Non configuré, on échoue à
   l'appel, bruyamment.
2. **Le nettoyage du contrat** — `ride.start`, `ride.complete` et
   `cash.limit.warning` retirés ; `ride.proposed` gardé, sa raison désormais
   écrite au contrat. Ta cartographie doit refléter les quatre.
3. **La réconciliation restaure un état complet** (D44) — l'identifiant de
   course avec le marqueur, pas le marqueur seul.

**Puis L4-12** — l'annulation notifiée à celui qui n'a pas annulé.

## Sur D43, et pourquoi la règle compte plus que le correctif

Tu avais tout vérifié : la variable injectée, la valeur littérale présente dans
le bundle produit, `bootstrap()` appelé avant tout rendu. Et l'appel partait
quand même chez Google.

La cause est banale. Ce qui l'a rendue **invisible** ne l'est pas : la
configuration non renseignée retombait sur l'adresse du vrai fournisseur. Le
code faisait exactement ce qu'il fait quand tout va bien, avec un destinataire
différent — impossible à voir sans regarder le trafic réseau.

Avec la règle, tu aurais trouvé la double instanciation en une minute au lieu
d'une nuit. Applique-la partout où une configuration de fournisseur externe a
un défaut, pas seulement ici.

## Sur D44, et ce que ton unification a révélé

Ton constat était juste : `force-engage` sans identifiant de course, c'est la
même limite que l'ancien `setEngaged`, pas une régression.

Mais l'unification change ce que cette limite signifie. Avant, engagement et
suivi étaient deux structures : un engagement réparé sans suivi était
visiblement incomplet. Maintenant qu'ils sont un seul enregistrement, la
réparation produit **un état qu'aucune transition normale ne peut produire** —
engagé, sans course — et rien ne le signale.

Odoo connaît l'identifiant : la réponse de l'endpoint le porte, la réparation
l'écrit.

C'est un gain de ton remaniement, pas un défaut : l'unification a rendu visible
quelque chose que la dispersion cachait.

## L4-12 — deux points

**Le destinataire dépend de l'acteur.** `action_cancel` le connaît déjà, c'est
son premier argument. Un client qui annule prévient le chauffeur, un chauffeur
prévient le client, un superviseur prévient les deux.

**Le message porte le motif.** Un chauffeur qui apprend qu'une course est
annulée sans savoir par qui ni pourquoi vient de rouler pour rien vers un point
de prise en charge. C'est le minimum de lui dire lequel des deux cas s'est
produit.

Et les trois règles habituelles, parce que cette tâche ressemble encore à du
câblage anodin : au commit et jamais pendant (D32), jamais depuis un savepoint
(D33), cet émetteur notifie sans transitionner (D31).

## Protocole — inchangé

Un commit par tâche, avec son entrée de rapport.

`make reset` et la passe finale complète sont dus.

**Et la vérification navigateur** — celle du parcours complet, jusqu'au résumé
de fin, que la recherche de lieu bloquait hier. C'est le critère 5 de L3-19, et
il n'a jamais pu être tenu.

Les fichiers d'écart vont dans `amoa/questions/<ID-TACHE>.md`, sur `master`.

## Rapport

`amoa/rapport-nuit-J20.md`, une entrée par tâche, commitée avec elle.

Et la même question : **qu'est-ce qui te laisse un doute pour un client réel ?**

## Ce que j'attendrai demain matin

Une course commandée, suivie, terminée et résumée dans un navigateur, sans un
seul contournement. Et une annulation qui prévient celui qui ne l'a pas
décidée.
```

---

## Après cette nuit

**L8-03 et L8-04** — partage de trajet et bouton d'urgence. Elles passent avant le lot Chauffeur :
ce sont les seules fonctions du produit qui touchent à la sécurité des personnes, elles sont
petites, et une application de moto-taxi sans bouton d'urgence ne devrait pas atteindre un pilote
avec de vrais passagers.

Puis le **lot Chauffeur** — c'est ce qui manque à sept des douze messages orphelins de la
cartographie. Le contrat est prêt, le serveur aussi.

Côté serveur : L3-12 (la file de rejeu) et L4-06 (la facture).

Et toujours, à délai subi : **la validation du plan comptable** et **la vérification développeur
Android**.
