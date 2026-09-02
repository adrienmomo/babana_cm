# services/odoo/scripts

Scripts d'exploitation exécutés dans un `odoo shell`, hors de l'arborescence du module
(`addons/babana/`) : ils ne sont ni installés ni testés par Odoo, ils pilotent une base déjà
installée.

## `seed.py` — jeu de données de démonstration

```bash
make seed          # depuis code/ ; installe le module babana au besoin, puis sème
```

Idempotent (D21) : rejouable sans produire de doublons. Contenu : zones réelles de Douala avec
grille tarifaire, flotte de chauffeurs approuvés (motos, documents, affectations), un client, un
superviseur, un historique de courses terminées avec leurs mouvements de compte courant.

Ne peuple **pas** le pool temps réel (positions « en direct ») — voir la docstring du fichier et
`amoa/questions/L0-06-live-driver-positions.md`. Pour la carte :

```bash
make seed-drivers  # tient les chauffeurs semés en ligne, positions dispersées (Ctrl-C pour arrêter)
```

`make seed-drivers` lance `services/realtime/scripts/demo-drivers.mjs`.
