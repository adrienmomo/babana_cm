-- État de course unifié côté chauffeur (L3-18, D26). Un seul enregistrement Redis par chauffeur
-- (une HASH), remplaçant trois structures distinctes qui portaient chacune un fragment du cycle
-- de vie : la réservation (L3-06), le marqueur d'engagement (L3-07), la session de suivi (L3-09).
-- Toute transition passe par CE script -- aucun écrivain direct ne subsiste ailleurs dans le
-- service (même règle, même vérification que le critère 6 de L3-06 pour le pool).
--
-- Champs de la HASH :
--   state    'reserved' ou 'engaged' (absence de la clé == libre, jamais un état écrit)
--   rideId   posé à l'acceptation, jamais avant
--
-- Les échéances restent distinctes (spécification, "le point délicat") : une réservation porte
-- une expiration courte (EXPIRE, action 'reserve') ; un engagement n'expire jamais tout seul
-- (PERSIST, action 'resolve' avec acceptation) -- un embouteillage à Douala ne doit pas remettre
-- au pool un chauffeur qui transporte un client (D26).
--
-- Trois actions, dispatchées par ARGV[1] :
--
-- 'reserve' -- KEYS[1] état, KEYS[2] pool des chauffeurs disponibles (AVAILABLE_DRIVERS_KEY).
--   ARGV[2] driverId, ARGV[3] durée de vie en secondes.
--   Même gate que l'ancien reserve.lua (L3-06), volontairement inchangée : le ZSCORE/ZREM sur le
--   pool reste l'unique section critique qui garantit qu'une seule tentative simultanée réussit
--   (test/concurrency/reservation.test.ts, L3-13, sans modification de ses assertions -- une
--   refonte qui changerait ce mécanisme serait fausse par construction, spécification critère 3).
--   Renvoie 1 si réservé, 0 si le chauffeur n'était pas disponible.
--
-- 'resolve' -- KEYS[1] état, KEYS[2] clé de rideId de la proposition active (proposalRideIdKey),
--   KEYS[3] index inverse rideId -> driverId (rideOwnerKey), utilisé seulement si acceptation.
--   ARGV[2] rideId attendu ('' pour ne pas vérifier -- l'expiration système ne vise pas une
--   course précise), ARGV[3] '1' si acceptation, '0' sinon (refus explicite ou expiration),
--   ARGV[4] driverId (valeur écrite dans l'index inverse -- KEYS[1] porte déjà ce driverId dans
--   son propre nom, mais l'index inverse doit pouvoir le retrouver depuis un rideId seul).
--   Même gate que l'ancien resolve.lua (L3-07) : l'état doit exister et porter 'reserved', et si
--   un rideId est attendu, il doit correspondre. Sur acceptation : passe à 'engaged', pose
--   rideId, PERSIST (retire l'expiration), pose l'index inverse. Sur refus/expiration : efface
--   l'enregistrement (retour à l'état libre). Renvoie 1 si CETTE résolution a pris effet, 0 sinon
--   (déjà résolu, ou rideId ne correspond pas -- acceptation tardive, critère 4 de L3-07).
--
-- 'release' -- KEYS[1] état. ARGV[2] préfixe de l'index inverse (RIDE_OWNER_KEY_PREFIX), pour
--   dériver dynamiquement la clé à effacer à partir du rideId lu dans la HASH -- le seul rideId
--   connu à cet instant est celui déjà écrit ici, jamais reçu en paramètre (fin de course et
--   annulation ne portent que le driverId, jamais le rideId, côté appelant -- même contrat que
--   l'ancien clearEngaged/releaseDriver, tous deux inconditionnels). Efface l'enregistrement
--   entier (retour à l'état libre) et son index inverse s'il existait. Inconditionnel : relâcher
--   un chauffeur déjà libre ne fait rien de plus, même idempotence que l'ancien code.
--
-- 'force-engage' -- KEYS[1] état. Pose l'état 'engaged' sans passer par une réservation
--   préalable, sans rideId ni index inverse (le suivi reste indisponible pour ce chauffeur tant
--   qu'une vraie acceptation n'écrit pas ces champs -- même limite que l'ancien `setEngaged`).
--   Seul appelant : la réconciliation (L3-17, critère 7), qui répare un écart contre Odoo --
--   source de vérité, jamais une réservation disputée. Inconditionnel, comme l'ancien
--   `setEngaged` (un simple `redis.set`) : ce script est le seul écrivain, sa gate est nulle ici
--   par design, pas par oubli.

local action = ARGV[1]

if action == 'reserve' then
  if redis.call('ZSCORE', KEYS[2], ARGV[2]) == false then
    return 0
  end
  redis.call('ZREM', KEYS[2], ARGV[2])
  redis.call('HSET', KEYS[1], 'state', 'reserved')
  redis.call('EXPIRE', KEYS[1], ARGV[3])
  return 1
end

if action == 'resolve' then
  if redis.call('HGET', KEYS[1], 'state') ~= 'reserved' then
    return 0
  end
  if ARGV[2] ~= '' then
    local activeRideId = redis.call('GET', KEYS[2])
    if activeRideId == false or activeRideId ~= ARGV[2] then
      return 0
    end
  end

  if ARGV[3] == '1' then
    redis.call('HSET', KEYS[1], 'state', 'engaged', 'rideId', ARGV[2])
    redis.call('PERSIST', KEYS[1])
    if ARGV[2] ~= '' then
      redis.call('SET', KEYS[3], ARGV[4])
    end
  else
    redis.call('DEL', KEYS[1])
  end
  return 1
end

if action == 'release' then
  local rideId = redis.call('HGET', KEYS[1], 'rideId')
  redis.call('DEL', KEYS[1])
  if rideId then
    redis.call('DEL', ARGV[2] .. rideId)
  end
  return 1
end

if action == 'force-engage' then
  redis.call('HSET', KEYS[1], 'state', 'engaged')
  redis.call('PERSIST', KEYS[1])
  return 1
end

return redis.error_reply('action inconnue : ' .. tostring(action))
