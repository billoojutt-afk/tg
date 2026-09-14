(() => {
  /* ================= background FX engine ================= */
  const MODES = ["aurora", "smoke", "fire", "water", "stars", "off"];
  const SHORT = { aurora: "Aurora", smoke: "Smoke", fire: "Fire", water: "Water", stars: "Stars", off: "Off" };
  const R = Math.random;

  const cssBg = document.getElementById("bgFX");
  const canvas = document.createElement("canvas");
  canvas.id = "bgFXCanvas";
  Object.assign(canvas.style, { position: "fixed", inset: "0", zIndex: "0", pointerEvents: "none", display: "none" });
  document.body.prepend(canvas);
  const ctx = canvas.getContext("2d");

  const btn = document.createElement("button");
  btn.id = "fxBtn";
  btn.type = "button";
  btn.title = "Background effect";
  btn.innerHTML = 'FX <span id="fxLabel"></span>';
  document.body.appendChild(btn);
  const labelEl = btn.querySelector("#fxLabel");

  let mode = localStorage.getItem("wfx") || "aurora";
  if (!MODES.includes(mode)) mode = "aurora";
  let W = 0, H = 0;
  let parts = [];
  let ripples = [];
  let raf = null;
  let last = 0;
  let time = 0;
  let glowAcc = 0, rippleAcc = 0, smokeAcc = 0;
  let reduced = false;
  try { reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) { }

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth; H = window.innerHeight;
    canvas.width = Math.floor(W * dpr); canvas.height = Math.floor(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (mode === "stars") buildStars();
  }
  window.addEventListener("resize", resize);
  resize();

  function buildStars() {
    if (!W || !H) return;
    parts = [];
    for (let i = 0; i < 150; i++) {
      parts.push({ x: R() * W, y: R() * H, r: 0.5 + R() * 1.5, ph: R() * 6.28, sp: 0.4 + R() * 1.4 });
    }
  }

  function spawnSmoke() {
    for (let i = parts.length; i < 70; i++) {
      parts.push({
        x: R() * W, y: H + R() * 90,
        r: 26 + R() * 44, a: 0.045 + R() * 0.06,
        vy: 0.15 + R() * 0.35, t: R() * 6.28, sw: 0.25 + R() * 0.55,
      });
    }
  }
  function stepSmoke(dt) {
    spawnSmoke();
    ctx.clearRect(0, 0, W, H);
    ctx.globalCompositeOperation = "lighter";
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      p.t += dt; p.y -= p.vy; p.x += Math.sin(p.t * p.sw) * 0.8;
      const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r);
      g.addColorStop(0, `rgba(150,172,210,${p.a})`);
      g.addColorStop(1, "rgba(150,172,210,0)");
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 6.283); ctx.fill();
      if (p.y < -p.r * 2) { parts[i] = { x: R() * W, y: H + R() * 90, r: 26 + R() * 44, a: 0.045 + R() * 0.06, vy: 0.15 + R() * 0.35, t: R() * 6.28, sw: 0.25 + R() * 0.55 }; }
    }
    ctx.globalCompositeOperation = "source-over";
  }

  const FIRE_C = ["255,94,0", "255,154,0", "255,207,0", "255,224,138"];
  function stepFire(dt) {
    for (let i = parts.length; i < 160; i++) {
      const life = 60 + R() * 80;
      parts.push({ x: R() * W, y: H + 5, vy: -(1 + R() * 2.5), r: 1.2 + R() * 3, c: FIRE_C[(R() * FIRE_C.length) | 0], t: R() * 6.28, sw: 0.5 + R() * 1.5, life, mx: life });
    }
    glowAcc += dt;
    if (glowAcc > 0.12) { glowAcc = 0; ripples.push({ x: R() * W, y: H - R() * 140, r: 34 + R() * 70, a: 0.07 + R() * 0.06, t: 0, life: 2.6 }); }
    ctx.clearRect(0, 0, W, H);
    ctx.globalCompositeOperation = "lighter";
    for (const g of ripples) { g.t += dt; g.r += dt * 24; g.a *= 0.985; }
    ripples = ripples.filter((g) => g.t < g.life && g.a > 0.005);
    for (const g of ripples) {
      const grad = ctx.createRadialGradient(g.x, g.y, 0, g.x, g.y, g.r);
      grad.addColorStop(0, `rgba(255,150,40,${g.a})`);
      grad.addColorStop(1, "rgba(255,120,20,0)");
      ctx.fillStyle = grad;
      ctx.beginPath(); ctx.arc(g.x, g.y, g.r, 0, 6.283); ctx.fill();
    }
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      p.t += dt; p.y += p.vy; p.x += Math.sin(p.t * p.sw) * 0.5;
      p.life -= dt * 60;
      if (p.life <= 0) { parts[i] = { x: R() * W, y: H + 5, vy: -(1 + R() * 2.5), r: 1.2 + R() * 3, c: FIRE_C[(R() * FIRE_C.length) | 0], t: R() * 6.28, sw: 0.5 + R() * 1.5, life: 60 + R() * 80, mx: 60 + R() * 80 }; continue; }
      const al = Math.min(1, p.life / p.mx) * 0.85;
      ctx.fillStyle = `rgba(${p.c},${al})`;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 6.283); ctx.fill();
    }
    ctx.globalCompositeOperation = "source-over";
  }

  function stepWater(dt) {
    for (let i = parts.length; i < 80; i++) {
      parts.push({ x: R() * W, y: H + 10, r: 2 + R() * 7, vy: -(0.4 + R() * 1.1), t: R() * 6.28, sw: 0.4 + R() * 0.8 });
    }
    rippleAcc += dt;
    if (rippleAcc > 0.45) { rippleAcc = 0; ripples.push({ x: R() * W, y: H - R() * H * 0.4, r: 5, vr: 45 + R() * 65, a0: 0.2 }); }
    ctx.clearRect(0, 0, W, H);
    ctx.globalCompositeOperation = "lighter";
    for (const g of ripples) { g.r += dt * g.vr; }
    ripples = ripples.filter((g) => g.r < 340);
    for (const g of ripples) {
      const al = g.a0 * (1 - g.r / 340);
      ctx.strokeStyle = `rgba(56,189,248,${al.toFixed(3)})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(g.x, g.y, g.r, 0, 6.283); ctx.stroke();
    }
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      p.t += dt; p.y += p.vy; p.x += Math.sin(p.t * p.sw) * 0.4;
      if (p.y < -20) { parts[i] = { x: R() * W, y: H + 10, r: 2 + R() * 7, vy: -(0.4 + R() * 1.1), t: R() * 6.28, sw: 0.4 + R() * 0.8 }; continue; }
      ctx.fillStyle = "rgba(56,189,248,0.07)";
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 6.283); ctx.fill();
      ctx.strokeStyle = "rgba(56,189,248,0.38)";
      ctx.lineWidth = 1.1;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 6.283); ctx.stroke();
      ctx.fillStyle = "rgba(255,255,255,0.5)";
      ctx.beginPath(); ctx.arc(p.x - p.r * 0.3, p.y - p.r * 0.3, p.r * 0.22, 0, 6.283); ctx.fill();
    }
    ctx.globalCompositeOperation = "source-over";
  }

  function stepStars(dt) {
    time += dt;
    ctx.clearRect(0, 0, W, H);
    ctx.globalCompositeOperation = "lighter";
    for (const s of parts) {
      const a = 0.25 + 0.6 * (0.5 + 0.5 * Math.sin(time * s.sp + s.ph));
      ctx.fillStyle = `rgba(220,230,255,${a.toFixed(3)})`;
      ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, 6.283); ctx.fill();
    }
    ctx.globalCompositeOperation = "source-over";
  }

  function step(dt) {
    if (mode === "smoke") stepSmoke(dt);
    else if (mode === "fire") stepFire(dt);
    else if (mode === "water") stepWater(dt);
    else if (mode === "stars") stepStars(dt);
  }

  function loop(now) {
    raf = requestAnimationFrame(loop);
    let dt = (now - last) / 1000; last = now;
    if (dt > 0.05) dt = 0.05;
    if (dt > 0) step(dt);
  }

  function stop() {
    if (raf) { cancelAnimationFrame(raf); raf = null; }
    parts = []; ripples = [];
    ctx.clearRect(0, 0, W, H);
  }

  function apply() {
    const isCanvasMode = mode === "smoke" || mode === "fire" || mode === "water" || mode === "stars";
    const effective = (reduced && isCanvasMode) ? "aurora" : mode;
    cssBg.style.display = (effective === "aurora") ? "" : "none";
    const useCanvas = !reduced && isCanvasMode;
    canvas.style.display = useCanvas ? "" : "none";
    stop();
    if (useCanvas) {
      if (mode === "stars") buildStars();
      last = performance.now();
      raf = requestAnimationFrame(loop);
    }
    localStorage.setItem("wfx", mode);
    labelEl.textContent = SHORT[mode];
    if (window.toast) window.toast(SHORT[mode] + " background");
  }

  btn.addEventListener("click", () => {
    const i = MODES.indexOf(mode);
    mode = MODES[(i + 1) % MODES.length];
    apply();
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stop();
    else if (canvas.style.display !== "none") { last = performance.now(); raf = requestAnimationFrame(loop); }
  });

  labelEl.textContent = SHORT[mode];
})();