'use strict';
/* ================================================================
   meditation/app.js — Landing page orchestrator
   - Animated EEG background canvas (sine waves)
   - README.md → marked.js → modal
   - Theme toggle with localStorage persistence
   - Hero description extracted from README
   ================================================================ */

/* ── Theme ──────────────────────────────────────────────────────── */

(function initTheme() {
  const saved = localStorage.getItem('meditation-theme') || 'dark';
  document.documentElement.setAttribute('data-theme', saved);
})();

document.getElementById('themeBtn').addEventListener('click', () => {
  const html = document.documentElement;
  const next = html.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  html.setAttribute('data-theme', next);
  localStorage.setItem('meditation-theme', next);
});

/* ── README modal ───────────────────────────────────────────────── */

let _readmeContent = null;

async function loadReadme() {
  _readmeContent = 'Generalized meditation tool designed for Neurofeedback, Biofeedback, and other trainings, using supported devices.'; //# meditation\n\n_README.md could not be loaded._';
  // if (_readmeContent) return _readmeContent;
  // try {
  //   const r = await fetch('README.md');
  //   if (!r.ok) throw new Error('fetch failed');
  //   _readmeContent = await r.text();
  // } catch(e) {
  //   _readmeContent = 'Generalized meditation tool designed for Neurofeedback, Biofeedback, and other trainings, using supported devices.'; //# meditation\n\n_README.md could not be loaded._';
  // }
  return _readmeContent;
}

function openReadmeModal() {
  const backdrop = document.getElementById('readmeBackdrop');
  const body     = document.getElementById('readmeBody');
  backdrop.style.display = 'flex';
  document.body.style.overflow = 'hidden';

  loadReadme().then(md => {
    if (typeof marked !== 'undefined') {
      body.innerHTML = marked.parse(md);
    } else {
      // Fallback: plain pre
      body.innerHTML = `<pre style="white-space:pre-wrap;font-size:12px">${
        md.replace(/&/g,'&amp;').replace(/</g,'&lt;')
      }</pre>`;
    }
  });
}

function closeReadmeModal() {
  document.getElementById('readmeBackdrop').style.display = 'none';
  document.body.style.overflow = '';
}

document.getElementById('readmeLink').addEventListener('click', e => {
  e.preventDefault();
  openReadmeModal();
});
document.getElementById('readmeFooterLink').addEventListener('click', e => {
  e.preventDefault();
  openReadmeModal();
});
document.getElementById('readmeClose').addEventListener('click', closeReadmeModal);
document.getElementById('readmeBackdrop').addEventListener('click', e => {
  if (e.target === e.currentTarget) closeReadmeModal();
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeReadmeModal();
});

/* ── Hero description from README ──────────────────────────────── */

loadReadme().then(md => {
  // Extract the first non-heading paragraph after "# meditation"
  const lines  = md.split('\n');
  let found = false;
  let desc  = '';
  for (const line of lines) {
    if (!found && /^#\s/.test(line)) { found = true; continue; }
    if (found && line.trim() && !line.startsWith('#') && !line.startsWith('```')) {
      desc = line.trim().replace(/\*\*/g, '').replace(/`[^`]+`/g, s => s.slice(1,-1));
      break;
    }
  }
  if (desc) document.getElementById('heroDesc').textContent = desc;
});

/* ── Device card stagger-in animation ──────────────────────────── */

const cards = document.querySelectorAll('.device-card');
const cardObs = new IntersectionObserver((entries) => {
  entries.forEach((entry, i) => {
    if (entry.isIntersecting) {
      const idx = [...cards].indexOf(entry.target);
      entry.target.style.animationDelay = `${idx * 0.07}s`;
      entry.target.classList.add('card-visible');
      cardObs.unobserve(entry.target);
    }
  });
}, { threshold: 0.1 });
cards.forEach(c => cardObs.observe(c));

/* ── Background EEG wave canvas ─────────────────────────────────── */

(function initCanvas() {
  const canvas = document.getElementById('bgCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  // Five sine layers representing δ θ α β γ bands
  const WAVES = [
    { freq: 0.3,  amp: 0.06, speed: 0.12, color: '107,125,179' },  // δ
    { freq: 0.55, amp: 0.09, speed: 0.20, color: '124,117,224' },  // θ  ← accent
    { freq: 0.9,  amp: 0.07, speed: 0.28, color: '45,184,145'  },  // α
    { freq: 1.4,  amp: 0.04, speed: 0.45, color: '224,112,80'  },  // β
    { freq: 2.2,  amp: 0.025,speed: 0.72, color: '224,176,32'  },  // γ
  ];
  const BASE_OPACITY = 0.055;   // very subtle — just texture
  let   phase        = 0;
  let   raf          = null;
  let   paused       = false;

  function resize() {
    canvas.width  = window.innerWidth;
    canvas.height = window.innerHeight;
  }

  function draw() {
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    WAVES.forEach(w => {
      const pts  = Math.ceil(W / 2);
      const yMid = H * 0.52;

      ctx.beginPath();
      for (let i = 0; i <= pts; i++) {
        const x   = (i / pts) * W;
        const t   = (i / pts) * Math.PI * 2 * w.freq * 4 + phase * w.speed;
        // Add a slower second harmonic for organic look
        const y   = yMid + Math.sin(t) * H * w.amp
                         + Math.sin(t * 1.7 + 1.2) * H * w.amp * 0.35;
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.strokeStyle = `rgba(${w.color},${BASE_OPACITY})`;
      ctx.lineWidth   = 1.5;
      ctx.stroke();
    });

    phase += 0.008;
  }

  function loop() {
    if (!paused) draw();
    raf = requestAnimationFrame(loop);
  }

  document.addEventListener('visibilitychange', () => {
    paused = document.hidden;
  });

  window.addEventListener('resize', resize);
  resize();
  loop();
})();
