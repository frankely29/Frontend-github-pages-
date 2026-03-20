(function () {
  const DEFAULT_LAYOUT = [
    { id: 'cue', x: 0.24, y: 0.5, color: 0xffffff, radius: 9, cue: true },
    { id: 'b1', x: 0.72, y: 0.5, color: 0xfbbf24, radius: 8 },
    { id: 'b2', x: 0.76, y: 0.465, color: 0x38bdf8, radius: 8 },
    { id: 'b3', x: 0.76, y: 0.535, color: 0xf97316, radius: 8 },
    { id: 'b4', x: 0.80, y: 0.43, color: 0xa855f7, radius: 8 },
    { id: 'b5', x: 0.80, y: 0.50, color: 0xef4444, radius: 8 },
    { id: 'b6', x: 0.80, y: 0.57, color: 0x10b981, radius: 8 },
    { id: 'eight', x: 0.84, y: 0.465, color: 0x111827, radius: 8, final: true },
  ];

  function normalizeBalls(match) {
    const state = match?.match_state || match?.state || {};
    const incoming = Array.isArray(state?.balls) ? state.balls : null;
    const source = incoming && incoming.length ? incoming : DEFAULT_LAYOUT;
    return source.map((ball, index) => ({
      id: String(ball?.id || `ball-${index}`),
      x: Number.isFinite(Number(ball?.x)) ? Number(ball.x) : DEFAULT_LAYOUT[index % DEFAULT_LAYOUT.length].x,
      y: Number.isFinite(Number(ball?.y)) ? Number(ball.y) : DEFAULT_LAYOUT[index % DEFAULT_LAYOUT.length].y,
      color: Number.isFinite(Number(ball?.color)) ? Number(ball.color) : undefined,
      cssColor: ball?.color,
      radius: Number.isFinite(Number(ball?.radius)) ? Number(ball.radius) : (ball?.cue ? 9 : 8),
      cue: ball?.cue === true || index === 0,
      final: ball?.final === true || /eight/i.test(String(ball?.id || '')),
      pocketed: ball?.pocketed === true,
    }));
  }

  function cssColorToHex(value, fallback) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    const text = String(value || '').trim();
    if (/^#?[0-9a-f]{6}$/i.test(text)) return parseInt(text.replace('#', ''), 16);
    return fallback;
  }

  function destroyInstance(instance) {
    if (!instance) return;
    try { instance.game?.destroy(true); } catch (_) {}
    if (instance.resizeHandler) window.removeEventListener('resize', instance.resizeHandler);
    instance.destroyed = true;
  }

  function createScene(instance) {
    const tableWidth = 960;
    const tableHeight = 540;
    const pocketRadius = 22;
    const pockets = [
      [42, 42], [tableWidth / 2, 34], [tableWidth - 42, 42],
      [42, tableHeight - 42], [tableWidth / 2, tableHeight - 34], [tableWidth - 42, tableHeight - 42],
    ];
    return class RealBilliardsScene extends Phaser.Scene {
      create() {
        const scene = this;
        scene.cameras.main.setBackgroundColor('#06281d');
        scene.add.rectangle(tableWidth / 2, tableHeight / 2, tableWidth, tableHeight, 0x0b5138);
        scene.add.rectangle(tableWidth / 2, tableHeight / 2, tableWidth - 30, tableHeight - 30, 0x0f7a51).setStrokeStyle(8, 0xd4b483, 0.95);
        pockets.forEach(([x, y]) => scene.add.circle(x, y, pocketRadius, 0x0a0f19, 1));

        scene.matter.world.setBounds(20, 20, tableWidth - 40, tableHeight - 40, 18, true, true, true, true);
        scene.balls = [];
        const ballBodies = [];
        instance.balls = normalizeBalls(instance.match);
        instance.balls.forEach((ball) => {
          const radius = Math.max(7, Number(ball.radius || 8));
          const x = ball.x * tableWidth;
          const y = ball.y * tableHeight;
          const fill = cssColorToHex(ball.cssColor, typeof ball.color === 'number' ? ball.color : (ball.cue ? 0xffffff : 0xfbbf24));
          const graphics = scene.add.circle(x, y, radius, fill, 1).setStrokeStyle(2, 0x0f172a, 0.25);
          graphics.setVisible(!ball.pocketed);
          const body = scene.matter.add.gameObject(graphics, { shape: { type: 'circle', radius }, restitution: 0.96, friction: 0.008, frictionAir: 0.015, frictionStatic: 0.01, slop: 0.02 });
          body.setCircle(radius);
          body.setBounce(0.96);
          body.setFriction(0.008, 0.01, 0.01);
          body.setFixedRotation();
          body.ballMeta = { ...ball, radius };
          if (ball.pocketed) {
            body.setStatic(true);
            body.setVisible(false);
          }
          scene.balls.push(body);
          ballBodies.push(body);
        });

        scene.aimLine = scene.add.line(0, 0, 0, 0, 0, 0, 60, 0, 0xffffff, 0.92).setLineWidth(2, 2);
        scene.powerLine = scene.add.line(0, 0, 0, 0, 0, 0, 0, 0, 0x7dd3fc, 0.88).setLineWidth(6, 6);
        scene.statusText = scene.add.text(28, 18, '', { fontFamily: 'system-ui, sans-serif', fontSize: '20px', color: '#e2e8f0', fontStyle: '700' });
        scene.turnText = scene.add.text(28, 42, '', { fontFamily: 'system-ui, sans-serif', fontSize: '14px', color: '#cbd5e1' });

        scene.events.on('update', () => {
          const cue = scene.balls.find((ball) => ball.ballMeta?.cue);
          const allStopped = scene.balls.every((ball) => ball.ballMeta?.pocketed || (Math.abs(ball.body.velocity.x) < 0.015 && Math.abs(ball.body.velocity.y) < 0.015));
          if (instance.pendingShot && allStopped) {
            instance.pendingShot = false;
            instance.onTurnSettled?.({ pocketed: instance.pocketedThisTurn.slice() });
            instance.pocketedThisTurn = [];
          }
          scene.statusText.setText(String(instance.statusText || 'Real Billiards'));
          scene.turnText.setText(String(instance.turnText || ''));
          if (!cue || cue.ballMeta?.pocketed || !instance.showAim) {
            scene.aimLine.setVisible(false);
            scene.powerLine.setVisible(false);
          } else {
            const angle = Number(instance.aim?.angle || 0);
            const power = Math.max(0.15, Math.min(1, Number(instance.aim?.power || 0.55)));
            const startX = cue.x;
            const startY = cue.y;
            const len = 110 + (power * 130);
            const endX = startX + Math.cos(angle) * len;
            const endY = startY + Math.sin(angle) * len;
            scene.aimLine.setTo(startX, startY, endX, endY).setVisible(true);
            scene.powerLine.setTo(startX, startY, startX - Math.cos(angle) * (28 + power * 50), startY - Math.sin(angle) * (28 + power * 50)).setVisible(true);
          }

          scene.balls.forEach((ball) => {
            if (ball.ballMeta?.pocketed) return;
            pockets.forEach(([px, py]) => {
              const dx = ball.x - px;
              const dy = ball.y - py;
              if ((dx * dx) + (dy * dy) <= Math.pow(pocketRadius - 4, 2)) {
                ball.ballMeta.pocketed = true;
                ball.setStatic(true);
                ball.setPosition(-100, -100);
                ball.setVisible(false);
                instance.pocketedThisTurn.push(ball.ballMeta.id);
                instance.onPocket?.(ball.ballMeta);
              }
            });
          });
        });
      }
    };
  }

  function mount(host, options) {
    if (!host || typeof Phaser === 'undefined') throw new Error('Phaser is not loaded.');
    const instance = {
      host,
      match: options?.match || null,
      aim: options?.aim || { angle: 0, power: 0.55 },
      statusText: options?.statusText || 'Real Billiards',
      turnText: options?.turnText || '',
      showAim: options?.showAim !== false,
      onPocket: typeof options?.onPocket === 'function' ? options.onPocket : null,
      onTurnSettled: typeof options?.onTurnSettled === 'function' ? options.onTurnSettled : null,
      pocketedThisTurn: [],
      pendingShot: false,
      destroyed: false,
    };
    const SceneClass = createScene(instance);
    const game = new Phaser.Game({
      type: Phaser.AUTO,
      parent: host,
      width: 960,
      height: 540,
      backgroundColor: '#06281d',
      scene: [SceneClass],
      physics: {
        default: 'matter',
        matter: { gravity: { y: 0 }, enableSleeping: true, positionIterations: 8, velocityIterations: 6 }
      },
      scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
    });
    instance.game = game;
    instance.resizeHandler = () => {
      const canvas = host.querySelector('canvas');
      if (canvas) canvas.style.borderRadius = '18px';
    };
    instance.resizeHandler();
    window.addEventListener('resize', instance.resizeHandler, { passive: true });
    return {
      updateAim(nextAim) {
        instance.aim = { ...instance.aim, ...(nextAim || {}) };
      },
      updateStatus(next) {
        instance.statusText = String(next?.statusText || instance.statusText || '');
        instance.turnText = String(next?.turnText || instance.turnText || '');
        if (typeof next?.showAim === 'boolean') instance.showAim = next.showAim;
      },
      takeShot({ angle, power }) {
        const scene = game.scene.scenes[0];
        const cue = scene?.balls?.find((ball) => ball.ballMeta?.cue);
        if (!cue || cue.ballMeta?.pocketed) return;
        const safePower = Math.max(0.18, Math.min(1, Number(power || 0.55)));
        const safeAngle = Number(angle || 0);
        const force = 0.010 + (safePower * 0.024);
        cue.applyForce({ x: Math.cos(safeAngle) * force, y: Math.sin(safeAngle) * force });
        instance.pendingShot = true;
        instance.showAim = false;
      },
      destroy() {
        destroyInstance(instance);
      }
    };
  }

  window.RealBilliardsUI = { mount };
})();
