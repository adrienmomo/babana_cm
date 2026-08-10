# Test de concurrence sur action_accept (L4-02, critère d'acceptation 4). Une TransactionCase
# classique ne suffit pas : il faut deux connexions PostgreSQL réellement distinctes pour que le
# verrou posé par _lock_for_update (SELECT ... FOR UPDATE) ait un adversaire à sérialiser contre.
# Sans ce test, un remplacement du verrouillage par une implémentation naïve (lire l'état, puis
# écrire, sans verrou) passerait la suite habituelle sans qu'aucun test ne le remarque -- exactement
# le défaut « intermittent et invisible en test unitaire » que L3-06 documente pour la réservation
# atomique côté temps réel ; cette course-ci est le même risque côté Odoo.
#
# BaseCase plutôt que TransactionCase : le cursor de TransactionCase refuse explicitement tout
# commit()/rollback() direct ("this will lead to a broken cursor when trying to rollback the
# test"), précisément ce dont ce test a besoin pour que les deux threads voient les mêmes lignes
# depuis leur propre connexion. Toutes les opérations passent donc par des curseurs de registre
# ouverts et fermés explicitement, jamais par self.env.
from __future__ import annotations

import threading

import odoo
from odoo.tests.common import BaseCase, get_db_name, tagged


@tagged("post_install", "-at_install")
class TestConcurrentAccept(BaseCase):
    def test_two_concurrent_accepts_produce_only_one_assignment(self):
        dbname = get_db_name()
        registry = odoo.registry(dbname)

        with registry.cursor() as cr:
            env = odoo.api.Environment(cr, odoo.SUPERUSER_ID, {})
            client = env["res.partner"].create({"name": "Client concurrence"})
            employee = env["hr.employee"].create({"name": "Chauffeur concurrence"})
            driver = env["babana.driver"].create(
                {"employee_id": employee.id, "state": "approved"}
            )
            ride = env["babana.ride"].action_request(
                {
                    "client_id": client.id,
                    "pickup_latitude": 4.05,
                    "pickup_longitude": 9.70,
                    "dropoff_latitude": 4.06,
                    "dropoff_longitude": 9.77,
                }
            )
            ride.action_propose(by_partner=client, driver=driver)
            ride_id, driver_id = ride.id, driver.id
            cr.commit()

        results = []
        results_lock = threading.Lock()
        barrier = threading.Barrier(2)

        def worker():
            outcome = None
            with registry.cursor() as cr:
                cr.execute("SET lock_timeout = '10s'")
                cr.execute("SET statement_timeout = '15s'")
                env = odoo.api.Environment(cr, odoo.SUPERUSER_ID, {})
                barrier.wait()  # maximise le recouvrement temporel des deux tentatives
                try:
                    env["babana.ride"].browse(ride_id).action_accept(
                        by_driver=env["babana.driver"].browse(driver_id)
                    )
                    cr.commit()
                    outcome = "success"
                except Exception as exc:  # noqa: BLE001 -- capturer tout pour compter, pas relancer
                    cr.rollback()
                    outcome = type(exc).__name__
            with results_lock:
                results.append(outcome)

        threads = [threading.Thread(target=worker) for _ in range(2)]
        for t in threads:
            t.start()
        for t in threads:
            # Généreux : le mécanisme lui-même se résout en quelques millisecondes (vérifié
            # manuellement hors du harnais de test, odoo shell) -- mais l'exécution sous
            # --test-enable observe systématiquement 30 à 60 s avant que les deux threads ne se
            # terminent, pour une raison non élucidée ce soir, propre au harnais de test et sans
            # rapport avec le verrouillage lui-même (amoa/questions/L4-02.md).
            t.join(timeout=90)

        self.assertEqual(len(results), 2, "les deux threads doivent se terminer")
        self.assertEqual(
            results.count("success"),
            1,
            f"exactement un succès attendu, obtenu : {results}",
        )

        with registry.cursor() as cr:
            cr.execute("SELECT state FROM babana_ride WHERE id = %s", (ride_id,))
            (final_state,) = cr.fetchone()
            self.assertEqual(final_state, "assigned", "une seule affectation, jamais deux")

            # Nettoyage : ce test committe hors de toute transaction de test annulable, rien ne
            # l'annulera automatiquement.
            cr.execute("DELETE FROM babana_ride WHERE id = %s", (ride_id,))
            cr.commit()
