/**
 * Identifiants partagés par les deux arborescences (L6-00). Les deux applications n'ont pas la
 * même forme -- ce qui se partage, ce sont les types de routes, pas la forme -- mais un
 * identifiant de course ou de chauffeur mal typé doit casser la compilation des deux côtés de la
 * même façon (critère d'acceptation 2). Alias distincts plutôt qu'un simple `string` partout :
 * passer un `DriverId` où un `RideId` est attendu doit rester une erreur de type, même si les
 * deux sont représentés par un UUID en chaîne (`RideIdSchema`/`DriverIdSchema`,
 * @babana/contracts).
 */
export type RideId = string & { readonly __brand: 'RideId' };
export type DriverId = string & { readonly __brand: 'DriverId' };

export function asRideId(id: string): RideId {
  return id as RideId;
}

export function asDriverId(id: string): DriverId {
  return id as DriverId;
}
