/**
 * lib/audioPanel.js — Wires up the shared audio control panel HTML
 * to Audio.* functions. Assumes these IDs exist in the currently mounted
 * mode's HTML (injected by the mode template):
 *   masterVolume, volVal, uploadRow, audioUpload, audioUploadBtn,
 *   uploadName, input[name="sound"]
 *
 * Exported API:
 *   AudioPanel.init(isSessionActiveFn)
 *   AudioPanel.startSelectedSound()
 *   AudioPanel.targetVolume   (getter)
 */

'use strict';

const AudioPanel = (() => {

  let _targetVolume    = 0.5;
  let _isSessionActive = () => false;

  function init(isSessionActiveFn) {
    _isSessionActive = isSessionActiveFn || (() => false);

    // ── Volume slider ──────────────────────────────────────
    const volSlider = document.getElementById('masterVolume');
    if (volSlider) {
      volSlider.value = _targetVolume;
      document.getElementById('volVal').textContent = Math.round(_targetVolume * 100) + '%';
      volSlider.addEventListener('input', e => {
        _targetVolume = +e.target.value;
        document.getElementById('volVal').textContent = Math.round(_targetVolume * 100) + '%';
        const fbVol = document.getElementById('fbVolume');
        if (!fbVol || !fbVol.checked) Audio.setMasterVolume(_targetVolume, 300);
      });
    }

    // ── Sound radio ────────────────────────────────────────
    document.querySelectorAll('input[name="sound"]').forEach(r => {
      r.addEventListener('change', () => {
        const uploadRow = document.getElementById('uploadRow');
        if (uploadRow) uploadRow.style.display = r.value === 'upload' ? 'flex' : 'none';
        if (_isSessionActive()) {
          Audio.stopSound();
          if (r.value !== 'none') {
            Audio.startSound(r.value);
            Audio.setMasterVolume(_targetVolume, 800);
          }
        }
      });
    });

    // ── Upload ─────────────────────────────────────────────
    const uploadBtn = document.getElementById('audioUploadBtn');
    const uploadInput = document.getElementById('audioUpload');
    if (uploadBtn && uploadInput) {
      uploadBtn.addEventListener('click', () => uploadInput.click());
      uploadInput.addEventListener('change', async e => {
        const file = e.target.files[0];
        if (!file) return;
        const nameEl = document.getElementById('uploadName');
        if (nameEl) nameEl.textContent = file.name;
        try {
          // Decode via a temporary AudioContext to avoid coupling to Audio internals
          Audio.ensureCtx();
          const tmpCtx = new (window.AudioContext || window.webkitAudioContext)();
          const ab     = await file.arrayBuffer();
          const decoded = await tmpCtx.decodeAudioData(ab);
          await tmpCtx.close();
          Audio.setUploadedBuffer(decoded);
        } catch(err) {
          console.error('Audio decode failed:', err);
        }
      });
    }
  }

  function startSelectedSound() {
    const checked = document.querySelector('input[name="sound"]:checked');
    const val = checked ? checked.value : 'none';
    if (val !== 'none') {
      Audio.startSound(val);
      Audio.setMasterVolume(_targetVolume, 1200);
    }
  }

  return {
    init,
    startSelectedSound,
    get targetVolume() { return _targetVolume; },
  };

})();
