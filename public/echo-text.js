(() => {
  const roots = document.querySelectorAll('h1:not([data-echo-disabled])');
  if (!roots.length) return;

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const directions = {
    right: { x: 1, y: 0 },
    left: { x: -1, y: 0 },
    up: { x: 0, y: -1 },
    down: { x: 0, y: 1 },
    diagonal: { x: .72, y: .72 }
  };
  const easings = {
    linear: value => value,
    'ease-out': value => 1 - ((1 - value) ** 3),
    'ease-in-out': value => value < .5 ? 4 * value ** 3 : 1 - ((-2 * value + 2) ** 3) / 2,
    snappy: value => 1 - ((1 - value) ** 5)
  };
  const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

  const setup = root => {
    const text = root.textContent.trim();
    if (!text) return;

    const echoCount = reducedMotion.matches ? 0 : clamp(Number(root.dataset.echoCount) || 7, 0, 18);
    const offset = clamp(Number(root.dataset.echoOffset) || 14, 0, 80);
    const lag = clamp(Number(root.dataset.echoLag) || .24, .02, .5);
    const fade = clamp(Number(root.dataset.echoFade) || .72, .1, .95);
    const blur = clamp(Number(root.dataset.echoBlur) || 2, 0, 12);
    const duration = Math.max(0, Number(root.dataset.echoDuration) || 650);
    const tint = root.dataset.echoTint || '#7dd3fc';
    const direction = directions[root.dataset.echoDirection] || directions.diagonal;
    const easing = easings[root.dataset.echoEase] || easings['ease-out'];
    const copies = [];
    const positions = [];

    root.classList.add('echo-text');
    root.textContent = '';

    for (let index = echoCount; index > 0; index -= 1) {
      const copy = document.createElement('span');
      copy.className = 'echo-text__echo';
      copy.setAttribute('aria-hidden', 'true');
      copy.textContent = text;
      copy.style.color = `color-mix(in srgb, ${tint} ${Math.min(72, 18 + index * 5)}%, currentColor)`;
      copy.style.opacity = '0';
      root.append(copy);
      copies[index] = copy;
      positions[index] = { x: direction.x * offset * (index + .35), y: direction.y * offset * (index + .35) };
    }

    const front = document.createElement('span');
    front.className = 'echo-text__echo--front';
    front.textContent = text;
    root.append(front);
    copies[0] = front;

    if (reducedMotion.matches || !echoCount) return;

    let frame;
    const started = performance.now();
    const pointer = { x: 0, y: 0 };
    const pointerMove = event => {
      const rect = root.getBoundingClientRect();
      const distanceX = event.clientX - (rect.left + rect.width / 2);
      const distanceY = event.clientY - (rect.top + rect.height / 2);
      const distance = Math.hypot(distanceX, distanceY);
      const reach = clamp(distance / 260, 0, 1);
      pointer.x = distance ? (distanceX / distance) * reach * offset : 0;
      pointer.y = distance ? (distanceY / distance) * reach * offset * .72 : 0;
    };

    window.addEventListener('pointermove', pointerMove, { passive: true });

    const render = now => {
      const progress = clamp((now - started) / duration, 0, 1);
      const entrance = 1 - easing(progress);

      for (let index = 1; index <= echoCount; index += 1) {
        const copy = copies[index];
        const position = positions[index];
        const desiredX = pointer.x + direction.x * offset * (index + .35) * entrance;
        const desiredY = pointer.y + direction.y * offset * (index + .35) * entrance;
        const interpolation = clamp(.34 / (1 + index * lag * 4.2), .018, .36);
        position.x += (desiredX - position.x) * interpolation;
        position.y += (desiredY - position.y) * interpolation;
        copy.style.transform = `translate3d(${position.x.toFixed(2)}px, ${position.y.toFixed(2)}px, 0)`;
        copy.style.opacity = String((fade ** index) * Math.max(entrance, .08));
        copy.style.filter = blur ? `blur(${(blur * index / echoCount).toFixed(2)}px)` : 'none';
      }

      frame = window.requestAnimationFrame(render);
    };

    frame = window.requestAnimationFrame(render);
    root._echoCleanup = () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('pointermove', pointerMove);
    };
  };

  roots.forEach(setup);
})();