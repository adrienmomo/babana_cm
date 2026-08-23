# Machine à états de babana.ride (L4-02). Les huit méthodes action_* ci-dessous sont les SEULES
# portes d'écriture sur `state` (invariant 2) -- write() ET create() le font respecter
# mécaniquement, pas seulement par convention (le garde-fou sur create(), absent jusqu'au 13
# août, est L4-02R2 -- amoa/questions/REPONSES-2026-08-13.md). Référence :
# docs/contracts/ride-state-machine.md (C-03R).
#
# La table des transitions n'est volontairement pas chargée depuis
# docs/contracts/ride-state-machine.json : ce fichier vit hors de l'arborescence montée dans le
# conteneur Odoo (services/odoo/addons uniquement). Dupliquée ici en connaissance de cause --
# c'est précisément ce que L4-10 (génération des tests depuis la table, hors de ce lot) est
# censé rendre impossible d'oublier de garder synchronisé.
from __future__ import annotations

import json
import logging

import psycopg2
from odoo import api, fields, models
from odoo.exceptions import UserError

from ..services import realtime_client
from ..services.pricing import FareBreakdown, round_breakdown_for_wire

_logger = logging.getLogger(__name__)

# Champs figés après `completed` (L4-01/L4-02) : distance, durée, tracé, montant final ne
# changent plus. `state` lui-même n'est pas dans cet ensemble -- il continue vers `settled` via
# action_settle, seule transition encore valide depuis `completed`.
_FROZEN_AFTER_COMPLETED_FIELDS = {
    "actual_distance_km",
    "actual_duration_minutes",
    "track_polyline",
    "final_amount",
}


class RideInvalidTransition(UserError):
    """Transition refusée -- à traduire en RIDE_INVALID_TRANSITION (catalogue C-01) par le
    contrôleur de L4-03, hors de ce lot."""


class BabanaRideState(models.Model):
    _inherit = "babana.ride"

    # Catégorie d'annulation (L4-07 corrigé le 11 août -- amoa/questions/REPONSES-2026-08-11.md).
    # `abandon_after_rejection` distingue l'abandon après un ou plusieurs refus d'une annulation
    # ordinaire : L9-09 (hors de ce lot) mesure ce taux d'abandon pour décider s'il faut rouvrir
    # D11, un indicateur que reconstituer après coup depuis l'historique des refus fragiliserait.
    cancel_category = fields.Selection(
        [("ordinary", "Annulation ordinaire"), ("abandon_after_rejection", "Abandon après refus")],
        default="ordinary",
    )
    cancelled_after_rejection_rank = fields.Integer(
        help="Nombre de refus essuyés par cette course au moment de l'abandon (L4-07, L9-09). "
        "0 hors du cas abandon_after_rejection.",
    )

    # --- Garde d'écriture (invariant 2) -------------------------------------------------------

    def write(self, vals):
        # Immuabilité totale après settled, y compris pour un administrateur, y compris pour une
        # transition (aucune n'existe depuis settled de toute façon -- double sécurité).
        for record in self:
            if record.state == "settled" and vals:
                raise UserError(
                    "Course encaissée (settled) : plus aucune modification n'est permise "
                    "(invariant 2)."
                )
            if record.state == "completed" and _FROZEN_AFTER_COMPLETED_FIELDS.intersection(vals):
                raise UserError(
                    "Distance, durée, tracé et montant sont figés après la fin de course "
                    "(invariant 2)."
                )

        if "state" in vals and not self.env.context.get("babana_allow_state_write"):
            raise UserError(
                "Écriture directe de 'state' interdite : passer par une méthode de transition "
                "(action_request, action_propose, action_accept, action_reject, action_start, "
                "action_complete, action_settle, action_cancel -- invariant 2)."
            )
        return super().write(vals)

    @api.model_create_multi
    def create(self, vals_list):
        # L4-02R2 (correction du 13 août -- amoa/questions/REPONSES-2026-08-13.md) : write()
        # interdisait déjà l'écriture directe de state, mais create() laissait passer
        # create({'state': 'settled', ...}) -- une course pourrait alors naître déjà encaissée
        # sans avoir traversé une seule transition. Même mécanisme de contexte que write(), donc
        # résistant à sudo() : seul action_request (state='requested' explicite) passe sans le
        # drapeau de contexte, puisque 'requested' est le seul état qu'une création est autorisée
        # à porter hors du chemin de transition.
        if not self.env.context.get("babana_allow_state_write"):
            for vals in vals_list:
                state = vals.get("state")
                if state and state != "requested":
                    raise UserError(
                        "Création directe avec state='%s' interdite : seule "
                        "action_request peut créer une course, à l'état 'requested' "
                        "(invariant 2)." % state
                    )
        return super().create(vals_list)

    def _babana_write_transition(self, vals):
        return self.with_context(babana_allow_state_write=True).write(vals)

    def _lock_for_update(self):
        # Sous REPEATABLE READ (Odoo, toutes connexions), un SELECT ... FOR UPDATE concurrent
        # n'attend pas toujours : PostgreSQL peut le refuser net (SerializationFailure) si la
        # ligne a été modifiée par une transaction validée depuis le début de celle-ci --
        # découvert le 14 août en vérifiant L4-11 contre une pile réelle (TransactionCase ne
        # peut jamais provoquer ce cas : une seule connexion n'entre jamais en conflit avec
        # elle-même). Savepoint pour ne pas invalider le reste de la requête si l'appelant
        # choisissait de rattraper l'exception localement -- ce n'est plus le cas ci-dessous,
        # mais garder le savepoint ne coûte rien et documente l'intention d'origine.
        #
        # SerializationFailure remonte ici telle quelle, jamais traduite en RIDE_INVALID_
        # TRANSITION (D25, 16 août -- amoa/questions/REPONSES-2026-08-16.md) : PostgreSQL dit
        # « ton instantané est périmé, rejoue-moi », pas « ta demande est invalide ».
        #
        # Le rejeu n'est PAS fait à la main ici, et c'est délibéré (amoa/questions/L4-02.md,
        # point 5) : sous REPEATABLE READ, l'instantané d'une transaction est fixé une fois pour
        # toutes à son ouverture. Ré-exécuter ce SELECT dans la MÊME transaction (via un
        # savepoint ou une boucle Python locale) retombe donc sur le même instantané périmé et
        # échoue à nouveau, indéfiniment -- vérifié empiriquement le 16 août, une tentative de
        # rejeu local a épuisé son budget de tentatives et fini en erreur technique brute à
        # chaque fois. Seule une transaction réellement neuve obtient un instantané neuf.
        # Or Odoo rejoue déjà la requête HTTP entière avec un curseur neuf sur exactement cette
        # famille d'erreurs : `odoo.service.model.retrying`, qui enveloppe tout `Dispatcher.
        # dispatch()` (donc cet appel de méthode) et réessaie jusqu'à
        # MAX_TRIES_ON_CONCURRENCY_FAILURE fois (5, avec temporisation aléatoire croissante),
        # en journalisant chaque tentative et l'épuisement final. C'est un rejeu plus complet
        # que ce qu'un rejeu local pourrait offrir : il repart avant même la ré-authentification
        # et la revalidation de la requête, donc avant la précondition, pas seulement avant elle.
        # Notre seule responsabilité est de laisser SerializationFailure remonter sans
        # l'attraper nulle part sur le chemin -- ici, et dans controllers/ride.py::_dispatch.
        self.ensure_one()
        with self.env.cr.savepoint():
            self.env.cr.execute(
                "SELECT id FROM babana_ride WHERE id = %s FOR UPDATE", (self.id,)
            )
        # Le verrou obtenu, une transaction concurrente a pu commiter un changement de state
        # pendant l'attente. Le cache Odoo, rempli par un browse() antérieur au verrou, doit
        # être invalidé pour que la lecture de self.state qui suit reflète la valeur réellement
        # committée -- pas une valeur périmée lue avant la mise en file d'attente sur le verrou.
        self.invalidate_recordset()

    def _babana_journalize(self, event, **details):
        # Point d'accroche unique pour L8-09 (amoa/questions/L4-02.md) : signature stable, prête
        # à écrire dans babana.audit.log une fois ce modèle immuable construit. Pour l'instant,
        # journal applicatif standard -- ne doit jamais faire échouer la transition (L8-09,
        # critère 3, anticipé ici par construction : une erreur de logging ne lève rien).
        try:
            _logger.info(
                "babana.ride %s : événement métier '%s' %s", self.reference, event, details or ""
            )
        except Exception:  # noqa: BLE001 - la journalisation ne doit jamais casser la transition
            pass

    # --- 1. draft -> requested ------------------------------------------------------------

    def action_request(self, vals):
        """Crée une course à l'état requested (L4-02). `draft` n'est jamais persisté (C-03) :
        il n'y a donc rien à verrouiller ni aucun état source à vérifier ici. L'unicité d'une
        course active par client (`requested` compris) est garantie par l'index partiel
        PostgreSQL de babana.ride (L4-01R, amoa/questions/REPONSES-2026-08-11.md) -- le contrôle
        applicatif équivalent, redondant depuis que cet index couvre `requested`, a disparu
        d'ici."""
        client_id = vals.get("client_id")
        if not client_id:
            raise UserError("client_id est requis pour demander une course.")

        ride = self.create({**vals, "state": "requested", "requested_at": fields.Datetime.now()})
        ride._babana_journalize("request_creation")
        return ride

    # --- 2/5. requested|rejected -> proposed ------------------------------------------------

    def action_propose(self, *, by_partner, driver):
        """Le client sélectionne un chauffeur (requested -> proposed, ou rejected -> proposed
        après un refus -- même action, C-03 ne distingue pas les deux par un nom différent)."""
        self.ensure_one()
        self._lock_for_update()

        if self.state not in ("requested", "rejected"):
            raise RideInvalidTransition(
                f"Impossible de proposer un chauffeur depuis l'état '{self.state}'."
            )
        if by_partner != self.client_id:
            raise RideInvalidTransition("Ce client n'est pas partie à cette course.")
        if driver.state != "approved":
            raise UserError("Seul un chauffeur approuvé peut être proposé.")

        # Chemin rapide pour le cas courant, PAS une garantie (relecture du 13 août --
        # amoa/questions/REPONSES-2026-08-13.md). Ce contrôle verrouille CETTE course, pas le
        # chauffeur : deux clients qui proposent le même chauffeur sur deux courses différentes
        # verrouillent chacun la sienne et passent tous deux ce SELECT. La garantie réelle est
        # l'index unique partiel babana_ride_one_active_per_driver (L4-01) -- traduite ci-dessous
        # (L4-03R, amoa/questions/L4-03.md) plutôt que laissée remonter en défaut technique brut.
        active = self.search(
            [
                ("driver_id", "=", driver.id),
                ("state", "in", ("proposed", "assigned", "in_progress")),
                ("id", "!=", self.id),
            ],
            limit=1,
        )
        if active:
            raise UserError("DRIVER_ALREADY_TAKEN")

        # Une course concurrente peut avoir gagné la course entre le SELECT ci-dessus et cet
        # UPDATE (la fenêtre que le SELECT seul ne ferme pas -- voir le commentaire ci-dessus) :
        # l'index unique partiel refuse alors l'écriture avec une IntegrityError PostgreSQL
        # brute. Même mécanisme que _lock_for_update() pour SerializationFailure : savepoint
        # pour n'annuler que cette tentative, pas toute la transaction de la requête, et
        # traduction en la même UserError("DRIVER_ALREADY_TAKEN") que le chemin rapide
        # ci-dessus -- le contrôleur (controllers/ride.py:_map_user_error) la connaît déjà.
        try:
            with self.env.cr.savepoint():
                self._babana_write_transition(
                    {
                        "state": "proposed",
                        "driver_id": driver.id,
                        "proposed_at": fields.Datetime.now(),
                    }
                )
        except psycopg2.errors.UniqueViolation as exc:
            if "babana_ride_one_active_per_driver" not in str(exc):
                raise
            raise UserError("DRIVER_ALREADY_TAKEN") from exc

        self._babana_journalize("proposal", driver=driver.id)
        return self

    # --- 3. proposed -> assigned -------------------------------------------------------------

    def action_accept(self, *, by_driver):
        self.ensure_one()
        self._lock_for_update()

        if self.state != "proposed":
            raise RideInvalidTransition(f"Impossible d'accepter depuis l'état '{self.state}'.")
        if by_driver != self.driver_id:
            raise RideInvalidTransition(
                "Ce chauffeur n'est pas celui de la proposition active de cette course."
            )

        self._babana_write_transition({"state": "assigned", "assigned_at": fields.Datetime.now()})
        self._babana_journalize("acceptance")
        return self

    # --- 4. proposed -> rejected --------------------------------------------------------------

    def action_reject(self, *, by_driver=None, reason=None, expired=False):
        self.ensure_one()
        self._lock_for_update()

        if self.state != "proposed":
            raise RideInvalidTransition(f"Impossible de refuser depuis l'état '{self.state}'.")
        if not expired and by_driver != self.driver_id:
            raise RideInvalidTransition(
                "Ce chauffeur n'est pas celui de la proposition active de cette course."
            )

        rejected_driver = self.driver_id
        self.env["babana.ride.rejection"].create(
            {
                "ride_id": self.id,
                "driver_id": rejected_driver.id,
                "reason": reason or ("expiré" if expired else None),
            }
        )
        self._babana_write_transition({"state": "rejected", "driver_id": False})
        self._babana_journalize("refusal", driver=rejected_driver.id, expired=expired)
        return self

    # --- 6. assigned -> in_progress -----------------------------------------------------------

    def action_start(self, *, by_driver):
        """Écrit `state = in_progress` -- corrigé pendant l'implémentation de L4-02 : la version
        précédente de ride-state-machine.md (C-03R) prévoyait de ne rien écrire ici, en
        cohérence avec « rien n'est écrit pendant le trajet ». Cette hypothèse s'est révélée
        intenable à l'épreuve du code : action_complete exige `state == in_progress` comme
        précondition (C-03), une exigence que rien ne peut jamais satisfaire si cette méthode
        n'écrit rien. Voir amoa/questions/L4-02.md, point 2, pour le détail et ce qui reste
        ouvert (le chronomètre et la distance, eux, restent bien exclusivement dans Redis --
        seul le changement d'état lui-même est écrit ici, une fois, à la décision du chauffeur)."""
        self.ensure_one()
        self._lock_for_update()

        if self.state != "assigned":
            raise RideInvalidTransition(f"Impossible de démarrer depuis l'état '{self.state}'.")
        if by_driver != self.driver_id:
            raise RideInvalidTransition("Ce chauffeur n'est pas celui affecté à cette course.")

        self._babana_write_transition(
            {"state": "in_progress", "started_at": fields.Datetime.now()}
        )
        self._babana_journalize("ride_start")

        # L3-19 (D31, D32) : pousse ride.started au client suivi et au chauffeur -- notifie
        # seulement, ne transitionne rien. Aucun savepoint ici (vérifié : cette méthode n'en
        # porte pas), donc rien à protéger de D33 -- l'appel suit directement l'écriture.
        client_public_id = self._babana_client_public_id()
        if client_public_id:
            realtime_client.notify_ride_started(
                self.env,
                ride_public_id=self.public_id,
                client_user_public_id=client_public_id,
                driver_public_id=by_driver.public_id,
            )
        return self

    # --- 7. in_progress -> completed ----------------------------------------------------------

    def action_complete(
        self, *, by_driver, actual_distance_km, actual_duration_minutes, track_polyline=None,
        final_amount,
    ):
        """Consolidation minimale (L4-04, hors de ce lot, apportera le calcul complet et le
        seuil de signalement d'écart) : reçoit les valeurs déjà consolidées côté appelant."""
        self.ensure_one()
        self._lock_for_update()

        if self.state != "in_progress":
            raise RideInvalidTransition(f"Impossible de terminer depuis l'état '{self.state}'.")
        if by_driver != self.driver_id:
            raise RideInvalidTransition("Ce chauffeur n'est pas celui affecté à cette course.")

        self._babana_write_transition(
            {
                "state": "completed",
                "completed_at": fields.Datetime.now(),
                "actual_distance_km": actual_distance_km,
                "actual_duration_minutes": actual_duration_minutes,
                "track_polyline": track_polyline,
                "final_amount": final_amount,
            }
        )
        self._babana_journalize("ride_completion")

        # L3-19 (D31, D32) : pousse ride.completed au client suivi et au chauffeur, avec le
        # détail décomposé GELÉ à la création (fare_rule_snapshot, D41) -- jamais recalculé, le
        # résumé de fin doit être ce que le serveur a réellement écrit. Aucun savepoint ici
        # (vérifié : cette méthode n'en porte pas, malgré ce que le lot de nuit supposait --
        # amoa/rapport-nuit-J19.md) : rien à protéger de D33, l'appel suit directement l'écriture.
        #
        # `fare_rule_snapshot` absent (courses créées directement par les tests hors du vrai
        # flux /quote -> /rides, ex. test_ride_state_machine.py) : dégrade en silence plutôt que
        # de lever -- même principe que D30 (un défaut de donnée dégrade l'affichage, jamais la
        # disponibilité). Une vraie course, elle, passe toujours par /quote (L2-04/L4-03R) et
        # porte donc toujours ce champ.
        client_public_id = self._babana_client_public_id()
        if client_public_id and self.fare_rule_snapshot:
            breakdown = FareBreakdown(**json.loads(self.fare_rule_snapshot))
            realtime_client.notify_ride_completed(
                self.env,
                ride_public_id=self.public_id,
                client_user_public_id=client_public_id,
                driver_public_id=by_driver.public_id,
                distance_meters=round(actual_distance_km * 1000),
                duration_seconds=round(actual_duration_minutes * 60),
                amount=round(final_amount),
                breakdown=round_breakdown_for_wire(breakdown),
            )
        return self

    # --- 8. completed -> settled ---------------------------------------------------------------

    def action_settle(self, *, by_driver, amount_collected):
        """Encaissement espèces (L4-05, D9). Trois effets dans une transaction unique : la
        transition elle-même, l'incrément du compte courant (L5-01), le contrôle de plafond
        (L5-02). **La génération de facture (L4-06) n'est pas ici** -- hors du lot qui a construit
        cette méthode, voir amoa/questions/L4-05.md ; `invoice_id` reste vide jusqu'à cette tâche,
        le champ existe déjà (babana_ride.py) précisément pour l'accueillir sans migration."""
        self.ensure_one()
        self._lock_for_update()

        if self.state != "completed":
            raise RideInvalidTransition(f"Impossible d'encaisser depuis l'état '{self.state}'.")
        if by_driver != self.driver_id:
            raise RideInvalidTransition("Ce chauffeur n'est pas celui affecté à cette course.")

        # Le montant encaissé est le montant dû, jamais une saisie libre (spécification) : le
        # chauffeur CONFIRME, il ne déclare pas. Vérifié avant d'entrer dans le savepoint --
        # aucun effet n'a encore eu lieu, rien à défaire si ce contrôle échoue.
        #
        # Comparaison monétaire d'Odoo (compare_amounts), pas une égalité de flottants
        # (amoa/questions/REPONSES-2026-08-19.md §3) : les montants sont aujourd'hui des Monetary
        # arrondis à l'unité et le franc CFA n'a pas de sous-unité, donc l'égalité stricte
        # fonctionne encore -- mais elle dépend d'un arrondi qui se produit ailleurs, et son mode
        # de défaillance est brutal (une course qui ne se solde jamais, avec un message qui accuse
        # le chauffeur à tort). compare_amounts compare à la précision de la devise, quelle que
        # soit l'origine de l'arrondi.
        expected_amount = self.final_amount or self.estimated_amount or 0
        if self.currency_id.compare_amounts(amount_collected, expected_amount) != 0:
            raise UserError("SETTLEMENT_AMOUNT_MISMATCH")

        # Savepoint : si un effet échoue (le mouvement de compte courant refuse un solde négatif,
        # improbable pour un encaissement toujours positif mais vérifié par construction plutôt
        # que par confiance), AUCUN des trois n'est appliqué -- même mécanisme que
        # action_propose ci-dessus (critère d'acceptation 2 de L4-05 : "l'échec d'un effet annule
        # tous les autres").
        with self.env.cr.savepoint():
            self._babana_write_transition({"state": "settled", "settled_at": fields.Datetime.now()})
            self.env["babana.cash.movement"].sudo().create(
                {
                    "driver_id": by_driver.id,
                    "movement_type": "collection",
                    "amount": amount_collected,
                    "ride_id": self.id,
                }
            )
            # Critère 3 de L5-02 : la mise hors ligne elle-même est un effet Odoo, défait avec les
            # deux autres si l'un d'eux échoue -- elle reste donc dans ce savepoint. L'appel
            # sortant qu'elle déclenche, lui, n'y est plus : D33 (amoa/questions/
            # REPONSES-2026-08-19.md §2, critère 6 de L4-05) -- voir plus bas, après la sortie
            # réussie du savepoint.
            cash_limit_crossed = by_driver._babana_apply_cash_limit()

        # D33 : cr.postcommit ignore les savepoints -- un rappel enregistré à l'intérieur y
        # survivrait même si le savepoint était annulé, dès lors que la transaction englobante
        # commite quand même (ce dépôt le fait délibérément, voir _lock_for_update ci-dessus).
        # L'intention (« ce chauffeur a franchi son plafond ») est donc retenue pendant le
        # savepoint sous la forme d'un simple booléen, et l'appel sortant n'est enregistré
        # qu'après sa sortie réussie -- pas avant, puisque c'est précisément l'endroit où l'on ne
        # sait pas encore si l'effet a vraiment eu lieu.
        if cash_limit_crossed:
            realtime_client.notify_cash_limit_reached(self.env, driver_public_id=by_driver.public_id)

        self._babana_journalize("settlement")
        return self

    # --- 9-13. * -> cancelled -------------------------------------------------------------------

    _CANCELLABLE_STATES = ("requested", "proposed", "assigned", "rejected", "in_progress")

    def action_cancel(self, *, actor_role, actor_record=None, reason=None):
        """Annulation, règles distinctes selon l'état et l'acteur (L4-07, hors de ce lot pour le
        détail complet -- seules les règles nécessaires aux critères de L4-02 sont ici : chaque
        transition valide de C-03 passe, chaque transition interdite échoue). `actor_role` vaut
        'client', 'driver' ou 'supervisor'."""
        self.ensure_one()
        self._lock_for_update()

        if self.state not in self._CANCELLABLE_STATES:
            raise RideInvalidTransition(f"Impossible d'annuler depuis l'état '{self.state}'.")

        if self.state == "in_progress" and actor_role != "driver":
            raise RideInvalidTransition(
                "Le client ne peut pas annuler une course déjà commencée (L4-07) ; "
                "voir babana.incident (L8-04, hors de ce lot)."
            )

        if actor_role == "client" and actor_record and actor_record != self.client_id:
            raise RideInvalidTransition("Ce client n'est pas partie à cette course.")
        if actor_role == "driver" and actor_record and actor_record != self.driver_id:
            raise RideInvalidTransition("Ce chauffeur n'est pas partie à cette course.")

        if actor_role == "driver" and not reason:
            raise UserError("Motif obligatoire pour une annulation par le chauffeur.")

        cancel_vals = {
            "state": "cancelled",
            "cancel_reason": reason,
            "cancelled_at": fields.Datetime.now(),
        }
        if self.state == "rejected":
            # Abandon après refus (L4-07 corrigé le 11 août) : aucune réservation à libérer --
            # elle l'a déjà été en entrant dans `rejected`. Catégorie et rang enregistrés
            # maintenant, pas reconstitués depuis l'historique des refus (amoa/questions/
            # REPONSES-2026-08-11.md).
            cancel_vals["cancel_category"] = "abandon_after_rejection"
            cancel_vals["cancelled_after_rejection_rank"] = len(self.rejection_ids)

        self._babana_write_transition(cancel_vals)
        self._babana_journalize("cancellation", actor_role=actor_role)

        # L4-12 (D31, D32, amoa/questions/REPONSES-2026-08-28.md §2) : pousse ride.cancelled à
        # celui qui N'A PAS décidé -- il le sait déjà, sinon. Le destinataire dépend donc de
        # l'acteur, connu ici (premier argument de cette méthode), jamais recalculé côté service
        # temps réel. `self.driver_id` reste lisible : seul action_reject l'efface (état
        # 'rejected'), jamais action_cancel -- une annulation depuis 'rejected' n'a donc, à raison,
        # aucun chauffeur à prévenir (celui qui a refusé n'est plus partie à cette course).
        notify_client_user_id = None
        notify_driver_id = None
        if actor_role in ("client", "supervisor"):
            notify_driver_id = self.driver_id.public_id if self.driver_id else None
        if actor_role in ("driver", "supervisor"):
            notify_client_user_id = self._babana_client_public_id()
        if notify_client_user_id or notify_driver_id:
            realtime_client.notify_ride_cancelled(
                self.env,
                ride_public_id=self.public_id,
                cancelled_by=actor_role,
                reason=reason,
                notify_client_user_id=notify_client_user_id,
                notify_driver_id=notify_driver_id,
            )
        return self
