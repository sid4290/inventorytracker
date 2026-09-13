(() => {
  const canvas = document.querySelector('.antigravity');
  if (!canvas || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  const context = canvas.getContext('2d');
  const pointer = { x: 0, y: 0, active: false };
  const particles = [];
  const particleCount = 180;
  let width = 0;
  let height = 0;
  let animationFrame;

  const resize = () => {
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    width = window.innerWidth;
    height = window.innerHeight;
    canvas.width = width * ratio;
    canvas.height = height * ratio;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
  };

  const makeParticle = () => ({
    x: Math.random() * width,
    y: Math.random() * height,
    z: Math.random(),
    angle: Math.random() * Math.PI * 2,
    radius: 14 + Math.random() * 34,
    speed: .0005 + Math.random() * .0015,
    phase: Math.random() * Math.PI * 2,
    size: .5 + Math.random() * 1.8
  });

  const resetParticles = () => {
    particles.length = 0;
    for (let index = 0; index < particleCount; index += 1) particles.push(makeParticle());
  };

  const draw = (time) => {
    context.clearRect(0, 0, width, height);
    const targetX = pointer.active ? pointer.x : width * .72 + Math.sin(time * .00035) * width * .12;
    const targetY = pointer.active ? pointer.y : height * .3 + Math.cos(time * .00045) * height * .1;

    particles.forEach((particle) => {
      particle.angle += particle.speed;
      const wave = Math.sin(time * .0012 + particle.phase) * 5;
      const targetRadius = particle.radius + wave;
      const targetParticleX = targetX + Math.cos(particle.angle) * targetRadius * (1 + particle.z * .5);
      const targetParticleY = targetY + Math.sin(particle.angle) * targetRadius;
      particle.x += (targetParticleX - particle.x) * .012;
      particle.y += (targetParticleY - particle.y) * .012;

      const alpha = .12 + particle.z * .3;
      context.fillStyle = `rgba(36, 87, 166, ${alpha})`;
      context.beginPath();
      context.arc(particle.x, particle.y, particle.size * (0.7 + particle.z), 0, Math.PI * 2);
      context.fill();
    });

    animationFrame = window.requestAnimationFrame(draw);
  };

  window.addEventListener('resize', () => {
    resize();
    resetParticles();
  }, { passive: true });
  window.addEventListener('pointermove', (event) => {
    pointer.x = event.clientX;
    pointer.y = event.clientY;
    pointer.active = true;
  }, { passive: true });
  window.addEventListener('blur', () => { pointer.active = false; });

  resize();
  resetParticles();
  animationFrame = window.requestAnimationFrame(draw);

  window.addEventListener('pagehide', () => window.cancelAnimationFrame(animationFrame), { once: true });
})();