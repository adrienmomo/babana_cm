-- Résolution atomique d'une proposition (L3-07) : accepter ou libérer, en une seule exécution.
-- Sans elle, une acceptation et l'expiration du minuteur de délai pourraient toutes deux
-- s'appliquer -- l'une poserait l'engagement après que l'autre a déjà remis le chauffeur au pool,
-- recréant une variante du défaut de L3-06R (D26) une couche plus haut : entre acceptation et
-- expiration, plutôt qu'entre réservation et position.
--
-- La comparaison de rideId (facultative, ARGV[1] vide pour l'ignorer -- l'expiration système ne
-- vise pas une course précise, elle vise "la proposition active de ce chauffeur, quelle qu'elle
-- soit") protège contre un message tardif qui référencerait une proposition déjà remplacée par
-- une nouvelle pour le même chauffeur : sans elle, une acceptation en retard pour une course A
-- pourrait valider par erreur une proposition postérieure et sans rapport pour une course B.
--
-- KEYS[1] : clé de réservation du chauffeur (reservation/keys.ts, reservationKey) -- double comme
--           marqueur "une proposition est active", posé par L3-06 à la réservation
-- KEYS[2] : clé d'identifiant de course de la proposition active (proposal/keys.ts, proposalRideIdKey)
-- KEYS[3] : clé d'engagement du chauffeur (driver/keys.ts, engagementKey)
-- ARGV[1] : rideId attendu, ou chaîne vide pour ne pas vérifier (expiration système)
-- ARGV[2] : '1' si l'issue est une acceptation, '0' sinon (refus explicite ou expiration)
--
-- Renvoie 1 si CETTE résolution a pris effet, 0 si la réservation était déjà résolue (acceptée,
-- refusée, ou expirée) avant cet appel, ou si le rideId attendu ne correspond pas -- le cas d'une
-- acceptation tardive (critère 4) ou d'une double acceptation (critère 5), qui doit échouer
-- proprement plutôt que produire une seconde transition.

if redis.call('EXISTS', KEYS[1]) == 0 then
  return 0
end

if ARGV[1] ~= '' then
  local activeRideId = redis.call('GET', KEYS[2])
  if activeRideId == false or activeRideId ~= ARGV[1] then
    return 0
  end
end

redis.call('DEL', KEYS[1])
redis.call('DEL', KEYS[2])
if ARGV[2] == '1' then
  redis.call('SET', KEYS[3], '1')
end
return 1
