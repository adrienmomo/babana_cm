{
    'name': 'Babana',
    'version': '18.0.1.0.0',
    'category': 'Babana',
    'summary': "Domaine métier de l'application de moto-taxi babana.cm",
    'description': """
Modèle de domaine, règles métier, contrôleurs exposés au mobile, back-office.
Voir amoa/01-architecture.md (décisions D1-D22) et amoa/03-decoupage-taches.md (découpage) à la
racine du dépôt pour le contexte complet.
""",
    'author': 'babana.cm',
    'license': 'LGPL-3',
    'depends': ['base', 'mail', 'hr', 'account'],
    'data': [
        'security/babana_groups.xml',
        'security/ir.model.access.csv',
        'data/babana_ride_sequence.xml',
        'views/babana_motorcycle_views.xml',
        'views/babana_assignment_views.xml',
    ],
    'installable': True,
    'application': True,
    'auto_install': False,
}
