# Prompt de lancement — session de nuit J14

**Objectif** : le premier écran métier.

---

## À faire avant de lancer

```bash
cd /Users/adrien/workspace/babana.cm
git add -A
git commit -m "amoa: débrief J13, D35 tout en REST, D36 fenêtre de grâce sur la rotation"
```

---

## Le prompt

```
Tu travailles sur babana.cm. Le répertoire courant est la racine du projet.

Lis `CLAUDE.md` en entier, puis `amoa/questions/REPONSES-2026-08-22.md`.

Ses §1 et §2 arbitrent les deux ponts manquants que tu as signalés — ils
n'étaient qu'un seul problème, et il venait de mon architecture.

## D'abord, ce que la nuit dernière n'a pas pu confirmer

Tu l'as proposé toi-même dans ton rapport : `make up`, puis la suite Odoo
complète et `test/concurrency` (L4-11). Rien de la nuit dernière ne les
touchait, mais deux sessions sans cette confirmation, c'est une de trop.
Fais-le avant d'écrire quoi que ce soit, et dis dans le rapport ce que tu as
trouvé.

## Périmètre de cette session

1. **D35** — `GET /me`, et le JSON-RPC abandonné pour les apps
2. **D36** — fenêtre de grâce sur la rotation du jeton de renouvellement
3. **L3-11** — reconnexion et rattrapage d'état, côté serveur
4. **L6-06** — écran d'accueil Client : carte, position, cinq chauffeurs,
   désignation du départ et de l'arrivée

**Si le lot ne passe pas en entier, arrête-toi avant L6-06** et dis-le. Un
premier écran bâclé coûte plus cher qu'un premier écran retardé d'une nuit :
c'est lui qui servira de patron aux quatorze suivants.

## D35 — `GET /me`, et pourquoi il manquait

Mon §5 réservait les lectures secondaires — historique, factures, **profil** —
au JSON-RPC natif. C'est pour ça que le profil n'a pas d'endpoint, et c'est pour
ça que tu as dû détourner `/auth/refresh` au démarrage.

Le partage reposait sur une hypothèse que je n'ai jamais vérifiée : que le
JSON-RPC natif accepte notre jeton. Tu as constaté qu'il ne l'accepte pas.

`GET /me` renvoie le même objet utilisateur qu'une session — même schéma, une
seule définition. Une fois qu'il existe, le rafraîchissement proactif au
démarrage disparaît : `restore()` puis `GET /me`, et le renouvellement
redevient ce qu'il doit être, une réaction à une expiration.

`createJsonRpcClient` peut rester dans le dépôt s'il ne coûte rien, mais plus
aucune tâche ne s'appuiera dessus — dis-le si tu préfères le retirer.

## D36 — la fenêtre de grâce, et ce qu'elle répare

Ceci n'est pas dans ton rapport, c'est ma relecture.

La rotation révoque toute la famille à la réutilisation d'un jeton consommé.
Bonne règle, qui suppose un réseau qui livre ou qui échoue franchement. Celui de
Douala ne fait ni l'un ni l'autre : une coupure entre l'envoi du jeton et la
réception de son remplaçant laisse l'ancien consommé côté serveur et aucun
nouveau côté téléphone. Au démarrage suivant, l'app présente le seul jeton
qu'elle a, et perd tout. Le chauffeur est déconnecté en pleine journée, et
l'événement ressemble à un vol dans les journaux.

Un jeton consommé depuis moins d'une fenêtre configurable renvoie **le même
couple qu'à son premier usage**. Ni révocation, ni troisième jeton émis — ce
point compte : émettre un nouveau couple laisserait deux appareils repartir avec
deux familles vivantes issues du même jeton, exactement ce que la rotation rend
impossible.

Teste aux deux bornes : juste avant la fin de la fenêtre, juste après.

## L3-11 — le pont qui manque à ton client

Tu as posé `session.resync` côté client sans personne en face. C'est cette
tâche.

Le rattrapage n'est pas un confort : à Douala, la coupure est le cas courant. Un
client qui rouvre son app pendant une course doit retrouver sa course, pas un
écran vide avec un bouton « commander ».

## L6-06 — le premier écran

Ton propre rapport a listé ce qu'il reste à écrire, et la liste est bonne.
Trois points que j'y ajoute.

**Le réticule avant la recherche textuelle.** L'adresse formelle n'existe
quasiment pas à Douala : la navigation se fait par repères. Désigner un point
en déplaçant la carte est le chemin principal, la recherche de lieu le
secondaire. Un écran qui suppose une saisie d'adresse échoue.

**Le géocodage inverse se déclenche au relâchement, jamais pendant le geste.**
Tu l'as anticipé — un appel par frame enverrait des centaines de requêtes pour
un seul déplacement, et sur un forfait de données compté, ça se voit.

**Un chauffeur sans profil s'affiche quand même** (D30), avec un avatar
générique. C'est la décision du 18 août : un défaut de cache dégrade
l'affichage, jamais la disponibilité.

Et le refus de la permission de localisation ne bloque pas l'écran : la carte
s'ouvre sur Douala, le client désigne son départ à la main.

## Protocole — inchangé

Un commit par tâche, avec son entrée de rapport.

`make reset` est dû : D35 et D36 touchent Odoo.

Lis les spécifications des tâches dépendantes : pour L6-06, lis L6-07 (ce que
l'écran doit lui transmettre) et L3-05.

Les fichiers d'écart vont dans `amoa/questions/<ID-TACHE>.md`, sur `master`.

## Rapport

`amoa/rapport-nuit-J14.md`, une entrée par tâche, commitée avec elle.

Et l'observation que je ne peux pas déduire du code : **qu'est-ce qui, dans cet
écran, te paraît fragile pour un chauffeur ou un client réel ?** Pas les
défauts que tu as corrigés — ce qui te laisse un doute.

## Ce que j'attendrai demain matin

Une carte de Douala, cinq chauffeurs dessus, un départ et une arrivée désignés
au doigt. Dans un navigateur suffit — l'export web du Client existe depuis
hier.
```

---

## Après cette nuit

L'enchaînement des écrans Client devient possible : L6-07 (estimation et choix du chauffeur), L6-08
(attente et refus), L6-09 (suivi et résumé). Puis les écrans Chauffeur, qui sont moins nombreux mais
plus exigeants — un écran qu'on regarde en conduisant.

Resteront côté serveur : L3-12 (la file de rejeu), L4-06 (la facture).

Et les deux démarches à délai subi : **la validation du plan comptable** et **la vérification
développeur Android**.
