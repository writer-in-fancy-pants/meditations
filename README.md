# meditation
Browser-based neurofeedback and HRV training tools — multi-device, shared library architecture. Generalized meditation tool. It integrates with various health devices - Muse 2, Muse S Athena, and Whoop band are currently supported. Using live EEG and heart rate data, it can train users via Neurofeedback, Biofeedback, and other training methods. 

## Supported devices and training methods
| Device    | Alpha/Theta   | HRV   |
|-----------|---------------|-------|
| Muse 2    | ✓ (EEG 4 channels) | ✓ (PPG)|
| Whoop band| :x:   | ✓ (Heartrate, RR)  |
|-----------|---------------|-------|

## Instructions
Instructions for various meditation methods included on the corresponding page. A minimal summary will be added here later

### Structure
```
meditation/
├── lib/                    ← Shared libraries (all devices)
│   ├── audio.js            ← Web Audio engine: sound generators, tones, adaptive volume
│   ├── audioPanel.js       ← Audio control panel HTML wiring
│   ├── bleClient.js        ← Web Bluetooth BLE Heart Rate GATT client
│   ├── chartUtils.js       ← Chart.js helpers: colors, datasets, rolling push
│   ├── hrv.js              ← HRV math (RMSSD, pNN50, coherence), charts, gauge
│   ├── theme.js            ← Dark/light theme toggle
│   └── wsClient.js         ← WebSocket singleton (connect, setOnFrame, setOnStatus)
│   └── youtubeAudio.js     ← Youtube audio integration for meditation tracks via url
│
├── muse2/                  ← Muse 2 EEG + PPG neurofeedback
│   ├── index.html
│   ├── app.js              ← Orchestrator (tab switching, WS connect)
│   ├── style.css
│   ├── bridge.py           ← EEG LSL → WebSocket (muselsl)
│   ├── ppg_bridge.py       ← PPG LSL → HR/RR → WebSocket (muselsl --ppg)
│   └── modes/
│       ├── at.js           ← Alpha/Theta EEG training (Peniston protocol)
│       ├── hrv.js          ← HRV training via Muse 2 PPG
│       └── howto.js        ← Training guide
│
├── whoop/                  ← WHOOP HRV training
│   ├── index.html
│   ├── app.js              ← Orchestrator with BLE + WebSocket dual connection
│   ├── style.css
│   ├── bridge.py           ← WHOOP BLE → WebSocket (bleak)
│   ├── hr_rr_simulator.py  ← Physiological data simulator (no hardware needed)
│   └── modes/
│       ├── hrv.js          ← HRV training with session duration + end alarm
│       └── howto.js        ← WHOOP-specific training guide
│
└── device/                 ← Boilerplate for a new device
    ├── index.html          ← Shell with placeholders
    ├── app.js              ← Orchestrator template
    ├── style.css           ← Copy of shared styles
    ├── bridge.py           ← Annotated Python bridge template
    └── modes/
        ├── main.js         ← Main mode template with all hooks
        └── howto.js        ← How To tab template
```

### Adding a new device

1. Copy `device/` to `your-device/`
2. Rename the module in `modes/main.js` (`Main` → your name)
3. Implement `device_reader()` in `bridge.py`
4. Fill in the template sections in `modes/main.js` and `modes/howto.js`
5. Update the `<title>`, topbar subtitle, and `localStorage` key in `app.js`
6. Add `your-device/` as a git submodule in the landing page repo

### Shared lib API summary

| Module | Key exports |
|--------|-------------|
| `wsClient.js` | `connect(url)`, `disconnect()`, `setOnFrame(fn)`, `setOnStatus(fn)`, `isConnected()` |
| `bleClient.js` | `connect({onData,onStatus})`, `disconnect()`, `isConnected()`, `isSupported()` |
| `hrv.js` | `rmssd(rr)`, `pnn50(rr)`, `coherenceIndex(rr)`, `initCharts({...})`, `updateCharts(...)`, `drawGauge(...)`, `sessionSummary(...)` |
| `audio.js` | `startSound(type)`, `stopSound()`, `playTone(hz)`, `crossoverChime()`, `coherenceChime()`, `endAlarm()`, `adaptVolume(...)`, `scheduleBeep(...)` |
| `chartUtils.js` | `colors()`, `makeDataset(...)`, `scaleX(cc)`, `scaleY(cc,label)`, `rollingPush(arr,val,max)` |
| `theme.js` | `init(onToggle?)`, `toggle()`, `current()` |
| `audioPanel.js` | `init(isActiveFn)`, `startSelectedSound()`, `.targetVolume` |

## Hardware setup

### Muse 2 (α/θ + HRV)
```bash
pip install muselsl pylsl websockets numpy scipy
muselsl stream                  # EEG → bridge.py
muselsl stream --ppg            # PPG → ppg_bridge.py
python muse2/bridge.py          # EEG bridge  (ws://localhost:8765)
python muse2/ppg_bridge.py      # PPG bridge  (ws://localhost:8765)
```

### WHOOP (HRV)
```bash
pip install bleak websockets
# Enable HR Broadcast in the WHOOP app
python whoop/bridge.py          # BLE bridge  (ws://localhost:8765)
# Or: direct Web Bluetooth in Chrome/Edge — no Python needed
# Or: python whoop/hr_rr_simulator.py --scenario meditation --loop
```

## Deployment

All tools are static files. Serve with any HTTP server:
```bash
cd meditation
npx serve .
python -m http.server 8080
```

Each device subdirectory can be deployed independently or as git submodules
of the landing page repo (see `muse-tools/` README).

## TODO
* Fix heart rate calculation in ppg bridge, use ACC?
* Combine the bridge to provide both heart rate and EEG input at the same time
* Add a feedback speed control dial with presets in seconds, % of windows [(60, 0.6), (10,0.75), (5, 0.9), (2,0.99)]
* Instructions at the bottom - start with loud setting, the music goes down with feedback
* Variations of the project - standalone without monitoring
* Youtube integration for tracks
* Pause the graph when session is stopped
* Reset the graphs on recalibrating
* Find a fix for streaming breaking (hardware or loop cli call)
* Add a reminder/notification when connection is broken / no input
* Test audio upload with rain sounds, Weightless by Marconi Union
* Integrate Live Neurofeedback into Muse2 dashboard
* Add an equivalent Muse Athena Live Neurofeedback
* Fix Tibetan gong sound for long sustain
* Check maths on neurofeedback, ensure correct ratio is calculated
* Add better (more meaningful) metrics to the comparator
