// Unitaire, en mémoire -- pas de vraie connexion réseau : ce module ne fait qu'orchestrer
// ping/pong/terminate() sur ce que `ws` lui fournit, une imitation minimale suffit et rend le
// test déterministe (pas de dépendance à la vitesse réelle d'un aller-retour TCP local).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { installLivenessHeartbeat } from '../src/ws/liveness';

class FakeSocket extends EventEmitter {
  terminated = false;
  pingCount = 0;
  ping(): void {
    this.pingCount += 1;
  }
  terminate(): void {
    this.terminated = true;
  }
}

class FakeWss extends EventEmitter {
  clients = new Set<FakeSocket>();
  connect(): FakeSocket {
    const socket = new FakeSocket();
    this.clients.add(socket);
    this.emit('connection', socket);
    return socket;
  }
}

describe('installLivenessHeartbeat (L3-20, volet serveur -- D47)', () => {
  test('une connexion qui répond systématiquement au ping ne termine jamais', async () => {
    const wss = new FakeWss();
    const { stop } = installLivenessHeartbeat(wss, 20);
    const socket = wss.connect();

    // Répond à chaque ping reçu, comme le ferait un vrai client -- exactement le comportement
    // attendu d'une connexion réellement vivante.
    const responder = setInterval(() => {
      if (socket.pingCount > 0) socket.emit('pong');
    }, 5);

    await new Promise((resolve) => setTimeout(resolve, 90));
    clearInterval(responder);
    stop();

    assert.equal(socket.terminated, false, 'une connexion qui répond ne doit jamais être terminée');
    assert.ok(socket.pingCount >= 2, 'plusieurs battements ont dû avoir lieu pendant le test');
  });

  test("une connexion qui ne répond plus est terminée -- au plus tard au battement suivant celui resté sans pong", async () => {
    const wss = new FakeWss();
    const { stop } = installLivenessHeartbeat(wss, 20);
    const socket = wss.connect();
    // Ne répond jamais -- exactement une connexion à moitié fermée sur un réseau mobile : rien
    // n'arrive, ni close, ni erreur, le silence est tout ce qu'on observe.

    await new Promise((resolve) => setTimeout(resolve, 90));
    stop();

    assert.equal(socket.terminated, true, "l'absence de réponse doit finir par terminer la connexion");
  });

  test('un pong ponctuel puis un silence prolongé termine quand même la connexion (pas de grâce indéfinie)', async () => {
    const wss = new FakeWss();
    const { stop } = installLivenessHeartbeat(wss, 20);
    const socket = wss.connect();

    // Répond une seule fois, au tout premier ping, puis se tait -- une connexion qui redevient
    // à moitié fermée en cours de route, pas dès l'ouverture.
    let respondedOnce = false;
    const onceResponder = setInterval(() => {
      if (!respondedOnce && socket.pingCount > 0) {
        respondedOnce = true;
        socket.emit('pong');
      }
    }, 5);

    await new Promise((resolve) => setTimeout(resolve, 120));
    clearInterval(onceResponder);
    stop();

    assert.equal(socket.terminated, true, 'un silence après une première réponse doit tout de même terminer la connexion');
  });

  test("stop() arrête le balayage -- aucun battement ni terminaison après l'arrêt", async () => {
    const wss = new FakeWss();
    const { stop } = installLivenessHeartbeat(wss, 20);
    const socket = wss.connect();
    stop();

    const pingsAtStop = socket.pingCount;
    await new Promise((resolve) => setTimeout(resolve, 90));

    assert.equal(socket.pingCount, pingsAtStop, "aucun battement supplémentaire après stop()");
    assert.equal(socket.terminated, false, "stop() ne doit pas lui-même terminer les connexions en cours");
  });
});
