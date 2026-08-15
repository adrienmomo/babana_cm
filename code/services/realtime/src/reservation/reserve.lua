-- Réservation atomique d'un chauffeur (L3-06). Un seul geste Redis : vérifier la présence dans
-- le pool des chauffeurs disponibles, la retirer, poser la réservation avec expiration -- tout
-- ou rien, dans la même exécution de script. C'est ce qui rend l'opération indivisible sans
-- verrou distribué : Redis exécute un script Lua jusqu'au bout avant de traiter toute autre
-- commande, y compris une autre exécution de ce même script (amoa/specs/L3-temps-reel.md, L3-06).
--
-- Aucun `if` conditionnel ne vit en TypeScript entre une lecture et une écriture -- la décision
-- (le chauffeur est-il encore disponible ?) et l'écriture (le retirer, poser la réservation) sont
-- ici, dans ce script, jamais séparées par un aller-retour réseau.
--
-- KEYS[1] : clé du pool géospatial des chauffeurs disponibles (geo-index.ts, AVAILABLE_DRIVERS_KEY)
-- KEYS[2] : clé de réservation propre à ce chauffeur (babana:driver:reservation:<driverId>)
-- ARGV[1] : identifiant du chauffeur
-- ARGV[2] : durée de vie de la réservation, en secondes
--
-- Renvoie 1 si la réservation a réussi, 0 si le chauffeur n'était pas disponible.

if redis.call('ZSCORE', KEYS[1], ARGV[1]) == false then
  return 0
end

redis.call('ZREM', KEYS[1], ARGV[1])
redis.call('SET', KEYS[2], '1', 'EX', ARGV[2])
return 1
