# Comparatif cartographie — Google Maps vs Mapbox

**Version** 1.0 — 9 août 2026
**Objet** Arbitrer le fournisseur de carte pour babana.cm, sachant que la v1 utilise un lien profond et que la v2 vise la navigation assistée dans l'application.
**Complément à** `01-architecture.md`

---

## 1. Correction d'une affirmation antérieure

J'avais avancé que le Navigation SDK de Google exigeait un accord Mobility séparé et n'était pas disponible pour React Native. **C'est faux sur les deux points.**

- Depuis le troisième trimestre 2024, le Navigation SDK est disponible comme **API autonome** : il n'est plus nécessaire d'être client Mobility Services.
- Google publie un **plugin officiel Navigation pour React Native** (comme pour Flutter). Il est open source et hors garanties de support Google Maps Platform, mais il existe et il est maintenu par Google.

Conséquence : le risque que j'avais signalé — devoir embarquer deux SDK de carte en v2 si l'on part sur Google en v1 — **n'existe pas**. Google Maps en v1 puis Google Navigation en v2 est un chemin cohérent chez un seul fournisseur.

---

## 2. Le vrai problème, et il concerne les deux fournisseurs

**Aucun des deux ne sait calculer un itinéraire de moto au Cameroun.**

La table de couverture officielle du Navigation SDK de Google donne, pour le Cameroun (CM) :

| Capacité | Cameroun |
|---|---|
| Couche trafic | Disponible |
| Itinéraires voiture / accrochage aux routes | Disponible |
| Itinéraires piéton | Disponible |
| **Itinéraires deux-roues** | **Non disponible** |
| Itinéraires vélo | Non disponible |
| Limitations de vitesse | Non disponible |
| Feux et stops | Non disponible |
| Perturbations en temps réel | Non disponible |

Google possède bien un mode de routage deux-roues — conçu exactement pour les pays où la moto-taxi domine — mais il n'est pas activé au Cameroun.

Côté Mapbox, la Directions API n'expose que quatre profils : `driving-traffic`, `driving`, `walking`, `cycling`. Il n'existe **aucun profil deux-roues, dans aucun pays**. La documentation Mapbox précise que le profil `driving` couvre indistinctement voiture, camion et moto.

### Ce que cela implique pour le produit

Un itinéraire calculé sur un modèle voiture est faux pour une moto, et il est faux **dans la direction qui compte** : la moto passe où la voiture ne passe pas, et l'embouteillage qui bloque la voiture ne la bloque pas. C'est exactement la proposition de valeur du CDC §I.3 — « éviter les embouteillages et réduire le temps de trajet ».

Trois conséquences de conception, indépendantes du fournisseur retenu :

1. **Le tarif doit s'appuyer sur la distance, pas sur la durée calculée.** Une composante temporelle assise sur une durée voiture surfacture systématiquement le client aux heures de pointe. Si une composante temps est conservée (CDC §II.3), elle doit se baser sur la **durée réellement écoulée** mesurée par le service temps réel, jamais sur l'estimation du routeur.
2. **L'ETA affiché avant validation (CDC §III.2) a besoin d'un facteur de correction local**, calibré sur les données du pilote. Un ETA voiture systématiquement pessimiste détruit la crédibilité de l'app.
3. **La distance facturée doit être la distance de l'itinéraire calculé**, pas la somme des points GPS, mais l'écart entre trajet réel et trajet calculé sera plus élevé que dans une app voiture, car le chauffeur prendra des raccourcis. À mesurer en pilote et à trancher : facture-t-on le calculé ou le parcouru ?

C'est le point le plus important de ce document, et il ne dépend pas du choix de fournisseur.

---

## 3. Comparaison sur les critères demandés

### Couverture des adresses à Douala

Le sujet est mal posé, et c'est important de le dire : **à Douala, l'adresse formelle n'existe quasiment pas**. La navigation se fait par repères — carrefours, stations, écoles, marchés — dont les noms d'usage diffèrent souvent des noms officiels. La qualité du géocodage d'adresses est donc un critère secondaire ; ce qui compte est la **couverture des points d'intérêt** et l'ergonomie de désignation d'un point sur la carte.

Sur ce terrain, Google est nettement devant : la base Places est incomparablement plus riche en Afrique centrale. L'expansion d'adresses annoncée par Mapbox — 73,2 millions d'adresses sur 45 pays — couvre l'Europe, le Moyen-Orient, l'Amérique latine et l'Asie du Sud-Est. L'Afrique n'y figure pas. Mapbox recommande d'ailleurs explicitement de tester la couverture pays par pays plutôt que de se fier aux listes générales.

**Avantage Google, net.**

### Modèle de coût

Les deux modèles ne varient pas selon la même grandeur, et c'est structurant.

| | Google | Mapbox |
|---|---|---|
| Rendu de carte | Facturé à l'affichage. Franchise de 10 000 requêtes par mois et par SKU Essentials | Facturé à l'utilisateur actif mensuel. Franchise de 50 000 chargements de carte par mois |
| Itinéraire hors navigation | Facturé à la requête | Franchise de 100 000 requêtes Directions par mois |
| Navigation assistée | **Par destination demandée**. Franchise de 1 000 par mois (palier Enterprise). Ni le guidage, ni les recalculs, ni le trafic ne sont refacturés | **Par utilisateur actif mensuel**. Deux options : forfait illimité (~4,75 $ par utilisateur actif) ou compteur de trajets (~0,225 $ par utilisateur actif plus ~0,013 $ par trajet guidé) |
| Grandeur qui pilote la facture | **Le volume de courses** | **Le nombre de chauffeurs** |

Cette dernière ligne est décisive compte tenu de D5 : avec des **chauffeurs salariés**, l'effectif est petit, connu à l'avance et croît lentement, tandis que le volume de courses est ce que vous cherchez à maximiser. Le modèle Mapbox plafonne donc l'exposition sur ce que vous maîtrisez ; le modèle Google la fait croître avec votre succès.

Ordre de grandeur, à 50 chauffeurs effectuant 400 courses par mois chacun, soit 20 000 courses :

- **Mapbox**, forfait illimité : 50 × 4,75 $ ≈ **238 $ par mois** pour la navigation, plus les utilisateurs actifs Maps SDK et les chargements de carte de l'app client — largement dans la franchise de 50 000 au démarrage.
- **Google** : 19 000 requêtes de navigation facturables après franchise. Le tarif public par destination du SKU « Navigation Request » n'est pas affiché sur les pages de documentation — il faut passer par le calculateur de tarifs ou un devis commercial. La fourchette générale des SKU Google va de 2 à 40 $ pour mille requêtes, ce qui laisse une incertitude d'un facteur vingt sur cette ligne. **À obtenir avant tout engagement en v2.**

**Avantage Mapbox sur la prévisibilité. Incertitude non résolue côté Google.**

### Faisabilité du turn-by-turn en React Native

| | Google | Mapbox |
|---|---|---|
| Plugin React Native | Officiel, publié par Google, open source, hors SLA | SDK natif officiel ; côté React Native, **enrobages communautaires** uniquement |
| Disponibilité au Cameroun | Itinéraires voiture disponibles, deux-roues non | Profil `driving` mondial, pas de profil deux-roues |
| Routage embarqué hors ligne | Non | Oui, via les tuiles de routage |

Deux éléments s'opposent ici. Google a le plugin React Native officiel — Mapbox n'a que du communautaire, ce qui est un vrai risque de maintenance sur un composant aussi lourd qu'un moteur de navigation. Mais Mapbox a le **routage embarqué hors ligne**, et le réseau mobile intermittent est un risque déjà identifié au §9 de l'architecture.

**Match nul, avec des risques de nature différente : dépendance communautaire chez Mapbox, dépendance réseau chez Google.**

---

## 4. Recommandation

**Google Maps en v1, et probablement en v2.**

Trois raisons :

1. La couverture des points d'intérêt à Douala est le critère fonctionnel décisif, et l'écart est important. Un client qui ne trouve pas sa destination n'utilise pas l'app.
2. Le plugin Navigation React Native officiel de Google supprime l'argument qui plaidait pour Mapbox — il n'y aura pas deux SDK de carte à embarquer en v2.
3. Le coût en v1 est proche de zéro : la navigation se fait par lien profond (gratuit), et seuls les chargements de carte et les requêtes d'itinéraire pour l'estimation sont facturés, à un volume de pilote faible.

**Deux conditions à respecter pour que ce choix reste réversible :**

**Une abstraction de carte et de navigation dans les apps.** Aucun composant écran ne doit importer directement le SDK. Une interface interne — afficher une carte, tracer un tracé, ouvrir un guidage vers un point, chercher un lieu — avec une implémentation par fournisseur. C'est quelques heures de conception qui rendent le changement de fournisseur possible plus tard sans réécrire les écrans. Sans cette abstraction, la décision de v1 devient irréversible de fait.

**Obtenir le tarif « Navigation Request » avant de s'engager en v2.** C'est la seule inconnue matérielle du comparatif, et elle porte un facteur vingt. Si le devis Google place la navigation au-delà de 500 $ par mois au volume cible, Mapbox en forfait illimité redevient le meilleur choix — et l'abstraction du point précédent rend ce basculement praticable.

---

## 5. Vérification à mener en pilote

Le comparatif documentaire ne tranche pas tout. Une journée de mesure sur données réelles réglera ce que les pages de tarifs ne disent pas.

1. Prendre trente couples départ–arrivée réels à Douala, issus de trajets moto observés.
2. Pour chacun, comparer : itinéraire retourné par chaque fournisseur, plausibilité pour une moto, durée annoncée contre durée réellement observée.
3. Mesurer le taux de résolution de la recherche de lieu sur cinquante repères d'usage courant à Douala, dans les deux bases.
4. En déduire le **facteur de correction d'ETA** à appliquer, qui sera nécessaire quel que soit le fournisseur (§2).

Cette mesure conditionne la formule tarifaire, restée ouverte au §10 de l'architecture. Elle devrait être planifiée dès le pilote, pas après.

---

## Sources

- [Navigation SDK country and region coverage — Google](https://developers.google.com/maps/documentation/navigation/android-sdk/coverage-nav-sdk)
- [Navigation SDK for Android Usage and Billing — Google](https://developers.google.com/maps/documentation/navigation/android-sdk/pricing)
- [Google Navigation for Flutter and React Native — Google](https://developers.google.com/maps/documentation/cross-platform/navigation)
- [Navigation SDK for Android FAQ (disponibilité autonome) — Google](https://developers.google.com/maps/documentation/navigation/android-sdk/faq)
- [Changes to Google Maps Platform pricing and monthly credit — Google](https://developers.google.com/maps/billing-and-pricing/faq)
- [Pricing — Mapbox Navigation SDK for Android](https://docs.mapbox.com/android/navigation/guides/pricing/)
- [Directions API — Mapbox](https://docs.mapbox.com/api/navigation/directions/)
- [Mapbox pricing](https://www.mapbox.com/pricing)
- [Mapbox Geocoding adds 45 countries and 73.2M new addresses](https://www.mapbox.com/blog/mapbox-geocoding-adds-45-new-countries-and-73-2-million-addresses)
- [Streets with no names: navigating the maze of African cities](https://www.modernghana.com/amp/news/713069/streets-with-no-names-navigating-the-maze-of-african-cities/)
