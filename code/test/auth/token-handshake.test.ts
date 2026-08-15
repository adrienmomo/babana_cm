// Test de bout en bout du jeton d'accès (C-01, critère 5 ; D23). Obtient un jeton par
// POST /auth/google contre le vrai Odoo (signIn(), test/concurrency/helpers/odoo-session.ts,
// réutilisé tel quel plutôt que réécrit), puis ouvre avec lui une connexion WebSocket contre le
// vrai service temps réel. C'est l'accord entre les deux services que ce test vérifie -- il
// n'appartenait à aucune tâche avant D23 : chaque suite propre à un service fabrique ses
// propres jetons pour se tester (services/realtime/test/*.test.ts,
// services/odoo/addons/babana/tests/test_token.py), et aucune des deux ne peut prouver que
// l'autre accepte réellement ce qu'elle émet.
//
// Contexte du défaut réparé : Odoo émettait "uid", le service temps réel exigeait "sub" -- les
// deux suites étaient vertes en désaccord total, et aucune connexion WebSocket réelle n'aurait
// jamais été acceptée en production (amoa/questions/REPONSES-2026-08-15.md, §1). Vérifié à
// blanc une fois (comme L3-13 l'exige pour un test de concurrence) : en remettant "uid" à la
// place de "sub" dans controllers/auth.py, ce fichier échoue -- voir le rapport de nuit J6.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { signIn } from '../concurrency/helpers/odoo-session';

const REALTIME_WS_ROOT = process.env.REALTIME_WS_ROOT ?? 'ws://localhost:3000';

interface HandshakeResult {
  opened: boolean;
  closeCode?: number;
}

// WebSocket global de Node (disponible nativement depuis Node 20, aucune dépendance ajoutée --
// CLAUDE.md, "pas de dépendance nouvelle sans nécessité") : interopère avec le serveur `ws`
// (services/realtime) puisque les deux implémentent le même protocole standard (RFC 6455).
// Fenêtre de grâce après l'ouverture : le serveur termine la poignée de main WebSocket avant de
// valider le jeton applicatif (ws/connection.ts, `wss.on('connection', ...)`) -- un jeton rejeté
// déclenche `socket.close()` juste APRÈS l'événement "open", pas avant. "open" seul ne prouve
// donc rien : il faut laisser passer cette fenêtre pour voir si une fermeture immédiate suit
// (bug trouvé en vérifiant ce test à blanc, voir amoa/rapport-nuit-J6.md -- un test qui accepte
// un jeton invalide ne prouve rien, même leçon que L3-13).
const OPEN_GRACE_PERIOD_MS = 300;

function attemptHandshake(accessToken: string): Promise<HandshakeResult> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${REALTIME_WS_ROOT}/rt/ws?token=${accessToken}`);
    const timeout = setTimeout(() => reject(new Error('handshake WebSocket : délai dépassé')), 10_000);
    let settled = false;

    function settle(result: HandshakeResult) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    }

    socket.addEventListener('close', (event) => {
      settle({ opened: false, closeCode: (event as { code: number }).code });
    });

    socket.addEventListener('open', () => {
      setTimeout(() => {
        if (settled) return;
        socket.close();
        settle({ opened: true });
      }, OPEN_GRACE_PERIOD_MS);
    });
  });
}

describe('C-01 critère 5 -- un jeton /auth/google réel est accepté par le service temps réel', () => {
  test('jeton client réel : connexion WebSocket acceptée', async () => {
    const session = await signIn(`token-handshake-client-${randomUUID()}`, 'client');
    const result = await attemptHandshake(session.accessToken);
    assert.equal(result.opened, true);
  });

  test('jeton chauffeur réel : connexion WebSocket acceptée (driverId distinct de sub, D23)', async () => {
    const session = await signIn(`token-handshake-driver-${randomUUID()}`, 'driver');
    const result = await attemptHandshake(session.accessToken);
    assert.equal(result.opened, true);
  });
});
