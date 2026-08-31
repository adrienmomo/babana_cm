/**
 * Délai d'acheminement d'une proposition (L7-04, critère 4) : de son émission serveur à son
 * affichage réel sur l'appareil du chauffeur. C'est ce chiffre qui dit si le délai d'acceptation
 * de trente secondes est réaliste -- et, sur une flotte pilote, ce qui permet de distinguer un
 * chauffeur qui refuse d'un chauffeur prévenu trop tard.
 *
 * Alimenté par le message `proposal.seen` (C-02) que l'app émet quand l'écran de proposition
 * s'est réellement affiché ; le serveur seul ne peut mesurer que jusqu'à la remise au fournisseur
 * push, or tout le délai qui compte vit après (veille du système, réseau, réveil de l'appareil).
 *
 * Compteurs en mémoire, même patron que `nearby/expand.ts` (`ExpansionMetrics`) et
 * `tracking/ingest.ts` (`IngestMetrics`) -- pas de dépendance de métriques nouvelle. Un futur
 * endpoint `/metrics` peut lire `snapshot()` directement.
 *
 * **Imprécisions connues, assumées** (rapport de nuit) : `delayMs` = `réception du proposal.seen`
 * − `emittedAt`, calculé avec l'horloge du serveur. Il inclut la latence de remontée du
 * `proposal.seen` lui-même (l'app a vu la proposition un peu plus tôt) ; il exclut en revanche
 * tout écart d'horloge appareil/serveur, puisque les deux bornes sont des instants serveur. Une
 * valeur négative (horloge, ou `emittedAt` falsifié) est ignorée ; une valeur aberrante au-delà
 * d'une heure aussi -- au pilote, le volume est négligeable, un point douteux ne vaut pas d'être
 * gardé.
 */

const MAX_PLAUSIBLE_DELAY_MS = 60 * 60 * 1000;

export interface ProposalDeliverySnapshot {
  /** Nombre de mesures retenues (un `proposal.seen` par proposition affichée). */
  count: number;
  /** Nombre de mesures ignorées (délai négatif, non analysable, ou aberrant). */
  discarded: number;
  /** Somme des délais retenus, en ms -- `sumMs / count` donne la moyenne sans stocker chaque point. */
  sumMs: number;
  /** Délai maximal observé, en ms (0 si aucune mesure). */
  maxMs: number;
  /** Mesures dont le délai a dépassé le budget d'acceptation : la proposition a pu expirer
   * pendant que le chauffeur la lisait. C'est le compteur qui répond directement à la question
   * « le délai de trente secondes est-il réaliste ». */
  overAcceptanceBudget: number;
}

export class ProposalDeliveryMetrics {
  private count = 0;
  private discarded = 0;
  private sumMs = 0;
  private maxMs = 0;
  private overAcceptanceBudget = 0;

  /**
   * @param delayMs délai émission -> affichage, calculé par l'appelant avec l'horloge serveur.
   * @param acceptanceBudgetMs budget d'acceptation courant (config), pour le compteur de dépassement.
   * @returns `true` si la mesure a été retenue, `false` si elle a été écartée comme non plausible.
   */
  record(delayMs: number, acceptanceBudgetMs: number): boolean {
    if (!Number.isFinite(delayMs) || delayMs < 0 || delayMs > MAX_PLAUSIBLE_DELAY_MS) {
      this.discarded += 1;
      return false;
    }
    this.count += 1;
    this.sumMs += delayMs;
    if (delayMs > this.maxMs) this.maxMs = delayMs;
    if (delayMs > acceptanceBudgetMs) this.overAcceptanceBudget += 1;
    return true;
  }

  snapshot(): ProposalDeliverySnapshot {
    return {
      count: this.count,
      discarded: this.discarded,
      sumMs: this.sumMs,
      maxMs: this.maxMs,
      overAcceptanceBudget: this.overAcceptanceBudget,
    };
  }

  reset(): void {
    this.count = 0;
    this.discarded = 0;
    this.sumMs = 0;
    this.maxMs = 0;
    this.overAcceptanceBudget = 0;
  }
}

export const proposalDeliveryMetrics = new ProposalDeliveryMetrics();
