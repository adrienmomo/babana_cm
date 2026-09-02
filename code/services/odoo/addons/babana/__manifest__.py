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
        'security/babana_record_rules.xml',
        'data/babana_ride_sequence.xml',
        'data/babana_cash_remittance_sequence.xml',
        'data/cron.xml',
        'views/babana_motorcycle_views.xml',
        'views/babana_driver_views.xml',
        'views/babana_assignment_views.xml',
        'data/fare_rule_default.xml',
        'views/babana_fare_rule_views.xml',
        'data/babana_zone_default.xml',
        'views/babana_zone_views.xml',
        'views/babana_remittance_views.xml',
        'views/babana_discrepancy_views.xml',
        'views/babana_incident_views.xml',
    ],
    'installable': True,
    'application': True,
    'auto_install': False,
    # D52 : remplit babana_public_id ligne par ligne sur res_users (table déjà peuplée) AVANT
    # que _add_sql_constraints ne pose unique(babana_public_id). Voir __init__.py.
    'pre_init_hook': '_pre_init_backfill_unique_defaults',
    # D53 : charge generic_coa et pose les comptes de remise de caisse APRÈS le ménage que
    # `account` fait en fin de chargement, puis impose la devise XAF. Voir __init__.py et
    # code/docs/odoo-pitfalls.md.
    'post_init_hook': '_post_init_currency_and_accounting',
}
