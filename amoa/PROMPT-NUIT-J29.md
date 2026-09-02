# Prompt de lancement — session de nuit J29

**Objectif** : rendre le produit montrable, et tirer le déploiement vers l'avant.

**À lancer après J28.** Cette nuit sert une démonstration client, et rien de ce qu'elle contient
n'est du travail jetable.

---

## À faire avant de lancer

```bash
cd /Users/adrien/workspace/babana.cm
git add -A
git commit -m "amoa: préparation de la démonstration client, seed absent et bundle web non servi"
```

---

## Le prompt

```
Tu travailles sur babana.cm. Le répertoire courant est la racine du projet.

Lis `CLAUDE.md` en entier, puis `amoa/07-demonstration.md`.

Cette nuit prépare une démonstration au client. Ses trois pièces sont au
périmètre pilote — rien n'est jetable.

## Périmètre de cette session

1. **Le jeu de données de démonstration** — `make seed` ne fonctionne pas
2. **Servir le bundle Client sous la même origine** — part de L6-18
3. **Le déploiement** — L0-07, autant qu'il peut l'être depuis ici

## 1. `make seed` n'a jamais fonctionné

Constaté aujourd'hui : la cible du `Makefile` pointe sur
`services/odoo/scripts/seed.py`, et ni le fichier ni son répertoire n'existent.
La commande figure dans la liste de `CLAUDE.md` depuis le premier jour et
personne ne l'a jamais lancée — les tests construisent chacun leurs propres
données.

C'est une commande qui a l'air de marcher parce qu'elle est écrite quelque part.
Vérifie s'il y en a d'autres dans le `Makefile` : `make verify` et
`make secrets-scan` méritent le même regard, et une commande documentée qui
échoue est pire qu'une commande absente.

**Ce que le jeu de données doit contenir**, pour qu'une base fraîche soit
montrable :

- Des zones réelles de Douala, avec leur grille tarifaire — `mock-maps` porte
  déjà des quartiers réels, réutilise-les plutôt que d'en inventer.
- Une poignée de chauffeurs approuvés, avec des noms plausibles, des motos
  affectées, des documents valides, et des positions dispersées dans la ville.
- Un client, et quelques courses terminées avec leur historique — un back-office
  vide ne montre rien.
- Un superviseur.

**Des valeurs plausibles, jamais aléatoires** (D21). Un chauffeur qui s'appelle
`test_driver_3` dans une démonstration coûte plus cher que le temps qu'il fait
gagner.

**Et le seed doit être rejouable** : deux exécutions consécutives ne doivent pas
produire deux flottes.

## 2. Servir le bundle sous la même origine

Caddy route le domaine principal, l'API et le back-office. Rien ne sert le
bundle du Client.

**Même origine, pas de CORS** (D46) : le bundle et l'API sous le même domaine,
comme en production. C'est le montage que ta vérification de J20 utilisait déjà
en jetable — cette fois il entre dans l'infrastructure.

**L'accès reste fermé** tant que les habilitations (L8-01, L8-02) n'existent
pas. Le back-office a déjà une liste d'adresses autorisées dans le Caddyfile ;
applique la même discipline au reste du domaine, par configuration.

## 3. Le déploiement

Va aussi loin que tu peux depuis cet environnement, et **dis précisément où tu
t'arrêtes** — ce qui exige un vrai VPS, un vrai DNS, de vrais secrets. La
frontière entre ce qui est fait et ce qui attend une machine doit être nette,
comme tu l'as tenue pour les dépendances natives.

## Protocole — inchangé

Un commit par tâche, avec son entrée de rapport.

`make reset` puis **`make seed`**, puis la passe finale — et cette fois `make
seed` doit vraiment tourner.

Les fichiers d'écart vont dans `amoa/questions/<ID-TACHE>.md`, sur `master`.

## Rapport

`amoa/rapport-nuit-J29.md`, une entrée par tâche, commitée avec elle.

Et une question précise : **le scénario du §3 de `07-demonstration.md` passe-t-il
en entier sur une base fraîchement seedée ?** Joue-le, et dis à quelle étape il
bute s'il bute. C'est cette répétition-là qui compte, pas les tests.

## Ce que j'attendrai demain matin

Une base fraîche, `make seed`, et un produit qu'on peut montrer sans avoir à
créer quoi que ce soit à la main.
```

---

## Après cette nuit

Le déploiement sera entamé et le produit montrable. Restera, en périmètre pilote : les
habilitations (L8-01, L8-02 — sous revue humaine), le back-office superviseur (L9-01 à L9-05), le
mode dégradé (L6-16), la file de rejeu (L3-12), la facture (L4-06), l'écran de recette (L5-07), les
sauvegardes (L8-08), les scénarios de bout en bout (L10-01) et l'OTP (L1-09, suspendu à la
passerelle SMS).

Plus **L6-19**, la passe avec un téléphone, dont trois dépendances natives dépendent.

**Premières courses visées au 13 octobre, marge au 20** — `amoa/06-jalons-et-pilote.md`.
