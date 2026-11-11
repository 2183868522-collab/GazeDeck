# GazeDeck

**Webcam eye gestures for personalized, accessible music interaction.**

GazeDeck is a browser-based research prototype for people who may benefit from hands-free interaction, including people with motor impairments. It combines personalized temporal gesture recognition, gaze-driven parameter sliders, and a two-deck music interface. It is not a medical device or a clinically validated assistive system.

This repository accompanies an **ACM IUI 2027 Demos submission**. It does not imply acceptance or a published DOI.

## Start here: download and run

You need **Python 3.10 or newer**, a desktop **Chrome or Edge** browser, and a webcam. Python serves the application using its standard library: no pip packages, npm installation, or JavaScript build step are needed to use it. MediaPipe JavaScript, WebAssembly, the face model and the Quick Experience model are included.

1. At the top of this repository, choose **Code → Download ZIP**. Extract the ZIP completely. Alternatively, clone this repository with Git.
2. Open a terminal **inside the extracted folder containing `serve.py` and `index.html`**.
3. Start the local server:

   **Windows (PowerShell or Command Prompt):**

   ```powershell
   py -3 serve.py
   ```

   If your Python installation uses `python`, run `python serve.py` instead.

   **macOS / Linux:**

   ```sh
   python3 serve.py
   ```

4. Keep that terminal open. If a page does not open automatically, visit **http://localhost:8917/index.html** on the same computer.
5. Select **English** in the language selector at the top right. The interface also supports Simplified Chinese.
6. Select your camera, choose **Start camera**, and allow camera access when the browser requests it.

**To stop:** return to the server terminal and press **Ctrl+C**. Do not double-click `index.html`: camera access and the model/bridge requests need the local server. If port 8917 is occupied, close your previous server, or run `python serve.py 9000` and use `http://localhost:9000/index.html`. Changing the port creates a different browser storage origin.

The optional `start.sh` helper uses `uv`; direct Python commands above do not require it. The browser application can run without external downloads after extraction. SoundCraft is optional and requires a separate native build for real DAW control.

## Quick Experience: try gestures without personal recording

1. Click **Quick Experience** at the top, or open the **⑧ Quick Experience** tab.
2. Start the webcam if it is not already running. The camera preview appears in the center of this page.
3. Face the screen naturally and remain relaxed while the temporary **session baseline** is collected. This uses 60 valid face-feature frames, not a fixed number of seconds. A gap in capture can restart collection.
4. Check that the bundled model has loaded and the session baseline is ready. A fresh installation automatically installs **168 templates**; no personal action recording or model training is required.
5. Try **Look Left, Look Right, Look Up, Look Down, Long Blink, and Double Blink**, one at a time, returning to rest between gestures. The page displays recognition results; it does **not** execute music commands on this page. Natural movement and Unknown results are not commands.
6. Once ready, use the button to **enter advanced control with the Quick Experience model**. Follow the current on-screen direction labels to navigate GazeDeck.

Quick Experience is a convenience entry path, not a claim of calibration-free or universally accurate recognition. It uses cross-source templates and a new temporary baseline. It does **not** replace your existing personal samples or calibration. In the current implementation, its advanced-control environment does **not** carry an independent gaze-slider calibration. Use manual slider controls, or switch to the personalized workflow below for calibrated continuous gaze adjustment.

The model manager can import/export a Quick Experience package, synchronize local users' latest samples, build/evaluate a candidate, enable it, and restore saved or initial versions. These actions manage the browser's local Quick Experience state; they do not update the public repository. The bundled model has not been evaluated in the same user-study conditions as the personalized mode.

## Personalized mode: calibrate, record, then control

1. Create or select a local user profile. Stop Quick Experience control and return to the regular training workflow when using your personal model.
2. In **① Calibration & Recording**, perform **neutral baseline calibration** while looking naturally at the center. Repeat it when the camera position or environment changes substantially.
3. Optionally complete **five-direction calibration**: center, left, right, up and down. This estimates personal eye-motion ranges. Default sensitivity parameters remain available if this calibration is skipped.
4. Record several examples of each intentional gesture: **Look Left, Look Right, Look Up, Look Down, Long Blink and Double Blink**. Also record **Natural** examples of ordinary, unintended movements. Natural examples help distinguish commands from routine motion.
5. For continuous sliders, complete the separate **left–center–right gaze-slider calibration**. It is distinct from the five-direction gesture calibration. Calibration pacing can be adjusted in Settings.
6. Use the recognition/testing controls to check your samples. The **Test & Improve** workflow can generate a candidate from reviewed errors and compare it on independent confirmation trials; it changes training samples only when you explicitly apply the improvement.
7. Open **⑦ GazeDeck Advanced Control**. Choose a function first, then a target (**A, B or AB**) using the current labels. Manual simulation buttons let you inspect the same interface workflow without relying on recognition.

Personal profiles, samples and settings are stored locally in the browser. Export data you need to retain; clearing browser site data or changing the origin/browser can make saved profiles unavailable. Recalibration and model selection are not uploads to this repository.

## Music interaction tutorial

### First use: browser demonstration

Enter GazeDeck and use the displayed direction labels to select functions and target decks. The default demonstration tracks are **silent placeholders**. Import your own local audio through the library/settings panel to hear browser playback.

For imported browser audio, play/pause, volume, seeking and playback-rate changes affect the HTML audio player. Demonstration EQ, effect and tone-preset controls illustrate the interaction workflow; they do **not** perform the SoundCraft DSP processing in the browser.

### Continuous parameter adjustment

With a personal gaze-slider calibration, open a parameter popup:

| Input | Behavior |
|---|---|
| Look left / right | Decrease / increase the value |
| Larger horizontal offset | Faster adjustment |
| Return to the central region | Stop adjustment |
| Look up | Restore the value from when the popup opened, keeping it open |
| Look down | Keep the current value and close |
| Long Blink | Enter/leave observation mode; gaze commands are suspended while observing |
| Double Blink | Cancel or undo where that operation supports it |

Parameter values stay within their supported ranges. The value label follows the slider thumb. The exact effect of discrete directions outside a popup depends on the current page; use its labels instead of assuming a fixed global direction-to-command mapping.

### Real audio control with SoundCraft

Real control needs **both** this Python server and a running **compatible SoundCraft integration build**. Installing an arbitrary upstream SoundCraft release does not guarantee the extra deck-control commands are present.

1. Follow [SoundCraft setup](docs/SOUNDCRAFT.md) to build the supplied optional integration source. No native executable is included in this repository.
2. Start SoundCraft with an audio session and its local control port enabled, for example `soundcraft --demo --control 7979`.
3. Start `serve.py` as above. The browser sends requests to Python on port **8917**; Python bridges them to SoundCraft's **JSON-lines TCP** control port **7979**.
4. Open the **SoundCraft connection test** panel. Connect, inspect the active project, and explicitly bind two different audio tracks to **Deck A** and **Deck B**. Enable real control after successful binding.
5. Check the real-control status before sending a command. Begin with play/pause and a small volume change. Use your own licensed audio or the SoundCraft synthesized demo.

The implemented real-control path supports A/B independent play/pause and bounded seeking; AB project transport and positioning; track replacement from project material or the imported library; volume, three-band EQ, reverb/delay/chorus, playback-rate adjustment, tone presets and audio reset. Live replacement does not require manually pausing A first; the other deck can keep playing. Undo is available only for supported operations. Track BPM/Key metadata may be unavailable and is not automatically inferred from arbitrary audio.

Transient status-read failures trigger read-only recovery checks. Controls must be retriggered after recovery; stale commands are not replayed. A changed project/session or sustained failure requires reconnecting. Returning to training retains an existing real-control connection for up to one minute before disconnecting it.

See [verification status](docs/VERIFICATION.md) for the difference between code coverage, recorded native command/readback checks, and unverified end-to-end audio/eye-control behavior.

## Technical architecture

```text
Webcam → MediaPipe Face Landmarker → 25-D features
        ├─ Personal baseline + recorded personal samples
        └─ Temporary session baseline + bundled Quick Experience templates
             ↓ normalization → temporal segmentation → resampling
             ↓ DTW similarity + distance-weighted kNN → rejection / command gating
             ↓ GazeDeck navigation and parameter controls
             ├─ Browser demonstration (HTML audio for imported files)
             └─ same-origin HTTP → serve.py → local TCP → SoundCraft

Continuous slider: relative iris signal → left/center/right calibration
                   → central dead zone + rate mapping → bounded parameter value
```

- Features: **17 eye/brow blendshape values, 2 eye-aperture values, 4 relative iris-position values and 2 coarse head-motion values**.
- Shared temporal classifier defaults, and the active bundled model: **20 resampled frames**, constrained DTW bandwidth **3 frames**, distance-weighted **kNN, k = 3**, **duration penalty weight 1**, and **rejection factor 2**. User settings and other saved model versions can differ.
- The duration penalty uses the absolute difference in log durations. Class-dependent rejection thresholds use nearest same-class template distances. Natural and Unknown normally do not execute commands. Personalized advanced control has an optional closest-guess setting; Quick Experience does not enable that override.
- Segmentation defaults: activity onset **2.5**, offset **1.5**, minimum inactive interval **400 ms**, duration bounds **60–4000 ms**, and **2** pre-roll frames. The default command refractory interval is **700 ms**.
- Continuous sliders use averaged horizontal iris displacement with coarse head-yaw compensation. Their calibrated rate controller is separate from temporal gesture classification; discrete recognized gestures provide popup restore/close and observation/cancel operations.

Key implementation files are `src/features.js`, `baseline.js`, `personal-calibration.js`, `segmenter.js`, `classifier.js`, `engine.js`, `gaze-slider.js`, `quick-model.js`, `quick-experience.js`, `gazedeck-flow.js`, `gazedeck-ui.js`, `soundcraft-client.js`, `soundcraft-panel.js`, and `serve.py`.

## Data, privacy and licenses

The bundled Quick Experience package contains **168 templates (24 per class across six gestures plus Natural)** and **837 de-identified numerical source samples across 14 source sets**, with model configuration and offline evaluation records. Source sets are not asserted to be 14 independent study participants. The package does not include participant names, user-profile identifiers, camera videos, raw face/eye images, personal device descriptions, or private local paths. See [data documentation](docs/DATA_AND_PRIVACY.md).

The project owner authorized public distribution of these de-identified features/templates. De-identification does not guarantee that derived biometric features cannot be linked back to individuals. No unrestricted data reuse license is implied. Raw participant recordings and full personal browser profiles are excluded.

**GazeDeck code and research-data reuse licenses are pending author specification.** This public repository does not add an MIT, Apache or Creative Commons grant to those materials. Bundled third-party components retain their own licenses and notices; see [third-party notices](docs/THIRD_PARTY.md). Restricted upstream brand artwork has been removed from the optional SoundCraft source archive.

## Evaluation and limitations

The authors report **10 participants**, **296 valid intentional-gesture trials**, and **224 correct recognitions**, giving **75.7% overall accuracy**. These are author-provided study aggregates, not measurements produced by the release checks or the bundled cross-source model evaluation. This repository does not independently reproduce the study analysis. It does not establish equivalent Quick Experience accuracy, clinical effectiveness, or a general response-time guarantee.

Important current limits include sensitivity to camera placement, head motion and lighting; dependence on representative personal samples; a Quick Experience population/domain mismatch risk; missing independent slider calibration in the Quick Experience entry path; no separately matched Quick Experience user study; and no validated end-to-end latency or listening-quality benchmark. Communication Board, Rhythm Accompaniment and other exploratory modules remain in the source but are not presented as core validated outcomes.

## Repository contents and developer checks

| Path | Contents |
|---|---|
| `index.html`, `*.css`, `src/`, `assets/` | Browser application, SVG-based interface blocks and recognition/control logic |
| `data/quick-model-default.v1.json` | Built-in model package; format v1, active model v2 |
| `models/`, `vendor/` | Face Landmarker model and local MediaPipe runtime |
| `serve.py`, `start.sh` | Local web service and SoundCraft bridge; optional uv launcher |
| `soundcraft-runtime/deck-live-load-20261108/` | Optional integration source archive and upstream notices |
| `tests/`, `scripts/` | Existing automated tests and supporting developer scripts |
| `docs/`, `third-party-licenses/` | Setup, data scope, verification and third-party license records |

Node.js 22 or newer is needed only for developer tests, not normal use. Run existing unit tests with `npm test`. Some developer browser scripts are separate tools and are not part of the unit-test command. Do not interpret synthetic/model-loading tests as human recognition validation.

**Known test limitation:** 11 legacy UI-harness cases currently fail because their mock DOM predates the slider-readout and advanced-navigation changes. `npm test` is not fully green. Recognition/model/flow checks and a limited actual-browser walkthrough are reported separately in [VERIFICATION.md](docs/VERIFICATION.md). Some English UI strings also remain untranslated or need editorial improvement.

## Troubleshooting

| Problem | What to check |
|---|---|
| Page cannot load | Run `serve.py` in an open terminal; check its reported port; extract the ZIP first |
| Camera unavailable | Use localhost, allow permission, choose the correct device, and close another application holding it |
| Baseline keeps restarting | Keep a visible face and a steady capture stream during collection |
| Quick model missing | Confirm `data/quick-model-default.v1.json` was extracted; inspect the local server error |
| No sound in demonstration | Default tracks are silent; import your own audio and check the output volume |
| SoundCraft cannot connect | Start the compatible build with `--control 7979`; keep `serve.py` running and check the project/track bindings |
| Gaze slider does not move | Complete independent slider calibration in personalized mode; Quick Experience currently has no such calibration |
| Stale interface after updating files | Reload with **Ctrl+F5**; do not delete personal browser data just to refresh code |

## Authors and citation

- **Yuxuan YANG** — first author.
- **Zhan CHEN** — second and corresponding author.

Prepared for **ACM IUI 2027 Demos submission**. Publication details and a formal paper citation will be added after they are available. Until then, cite the repository URL and the exact commit you used; no DOI or acceptance status is asserted.
