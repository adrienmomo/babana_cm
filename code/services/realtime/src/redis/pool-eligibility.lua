-- Script d'éligibilité du pool des chauffeurs disponibles (D26, L3-06R) -- SEUL point d'écriture
-- (GEOADD) sur la clé du pool, dans tout le service. Un chauffeur entre dans le pool si et
-- seulement si, dans la même exécution : il est marqué en ligne, il n'a ni réservation ni
-- engagement actifs (L3-18, état de course unifié -- amoa/specs/L3-temps-reel.md, L3-06, section
-- "Ce n'est pas la réservation qu'il faut rendre atomique, c'est le pool"), et il n'est pas
-- bloqué pour plafond d'encaisse (D8, D28, L5-02, point de blocage 1 -- driver/cash-guard.ts).
--
-- Sans cette garantie unique, un chauffeur réservé ou engagé qui émet une position normale
-- (L3-02, un chauffeur en attente de proposition ou en course continue d'émettre) reviendrait
-- dans le pool à la position suivante -- le défaut relevé le 16 août
-- (amoa/questions/REPONSES-2026-08-16-J7.md §2) : la fenêtre n'était pas microscopique, elle
-- était permanente.
--
-- KEYS[1] : clé du pool géospatial (AVAILABLE_DRIVERS_KEY, redis/geo-index.ts)
-- KEYS[2] : drapeau "en ligne" du chauffeur (driver/keys.ts, onlineFlagKey)
-- KEYS[3] : état de course unifié du chauffeur (ride/state.ts, rideStateKey -- L3-18) : réservé
--           OU engagé, une seule existence de clé tranche les deux cas que quatre clés
--           distinguaient avant cette tâche
-- KEYS[4] : clé de blocage pour plafond d'encaisse (driver/keys.ts, cashBlockedKey)
-- ARGV[1] : identifiant du chauffeur
-- ARGV[2] : longitude
-- ARGV[3] : latitude
--
-- Renvoie 1 si le chauffeur a été (ré)inséré dans le pool, 0 sinon -- 0 n'est PAS une erreur :
-- c'est le cas normal et attendu d'un chauffeur réservé, engagé ou bloqué qui vient d'émettre une
-- position, ou d'un chauffeur pas encore marqué en ligne.

if redis.call('EXISTS', KEYS[2]) == 1
  and redis.call('EXISTS', KEYS[3]) == 0
  and redis.call('EXISTS', KEYS[4]) == 0
then
  redis.call('GEOADD', KEYS[1], ARGV[2], ARGV[3], ARGV[1])
  return 1
end

return 0
