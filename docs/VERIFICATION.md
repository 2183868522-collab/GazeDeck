# Release verification — 2026-11-11

This report separates this release's checks from earlier development evidence and author-reported study results. No camera recording, new user study or listening test was performed for packaging.

## Performed for this release

| Check | Result and scope |
|---|---|
| JavaScript syntax | All 53 `src/*.js` files passed `node --check` |
| Python syntax | `serve.py` parsed successfully with Python 3.12.14 |
| Isolated service startup | Passed with `python -I serve.py <free-port> --no-browser`, temporary app-data directories and no installed third-party Python packages |
| Runtime resource completeness | 92 HTML/CSS/JS/WASM/model/SVG resources and the bundled quick model were served and matched the local files; the count of 92 includes the quick-model resource |
| Static relative module/asset references | No missing referenced local files found by the release audit |
| Local song-library endpoint | HTTP 200 with a fresh application-data directory |
| SoundCraft status endpoint | HTTP 503 because no compatible native instance was running; not a successful real-audio test |
| Quick model integrity | 14 generic source sets, 837 samples, 168 templates, 20 × 25 numeric sequences, matching source IDs and active model v2; retired model absent |
| Face Landmarker model | SHA-256 matches the checked official bundle |
| Privacy packaging | No raw participant media in the web tree; generic sample/source identifiers; no matches for the checked credential/private-Windows-path/email patterns in release text; nested native archive reviewed separately |
| Native integration archive | Restricted brand artwork and machine-specific planning document removed; all Rust files and Cargo build inputs byte-identical to the integration snapshot; ZIP integrity passed |
| Fresh browser startup | Model ready on a new localhost origin with no pre-existing profiles or application data |
| Quick Experience entry | Page opened; bundled model displayed 168 templates and 837 samples without importing a personal profile; entry into advanced control correctly disabled before session-baseline readiness |
| English UI selection | Working for navigation and controls; some model names, source-set labels and explanatory strings still appear in Chinese or imperfect English |
| DJ manual UI | Main mixer, function-then-target navigation, Deck A volume 70 → 65, confirm, observation-mode command suspension, resume and undo to 70 verified in the actual browser |
| Demo playback UI | Play/pause changed the selected deck's demo playback state; default demo is silent, so this is not proof of audible playback |
| Browser console | No error-level messages observed during that limited UI walkthrough |
| Cleanup | Both temporary `serve.py` instances started for verification were terminated; no test server intentionally left running |

## Existing unit tests and known test debt

Node.js 24.22.1 initially could not run the original `node --test tests/` command on this environment. The release's `package.json` now explicitly selects `tests/*.test.js` and `tests/*.test.mjs` so it does not accidentally execute separate browser automation scripts.

The initial suite contained **96 tests: 83 passed and 13 failed**. Two failures used seek positions longer than the new 15-second default demo track. Those two fixtures now explicitly use a 240-second track, preserving the seek/undo assertions; all **14 flow tests** passed on the affected-file rerun. Across those runs, **85 tests passed**, while **11 legacy `gazedeck-ui.test.js` cases remain failing** because their DOM double has no `document` for the added slider-readout rendering. That UI harness also predates the two-stage advanced navigation. It is retained, not skipped or relabeled as passing. `npm test` therefore currently exits nonzero. Updating that harness is outstanding work; the manual browser walkthrough above covers only its stated operations, not all assertions in that file.

Passing existing tests cover synthetic recognition/segmentation/rejection, personal calibration and baseline handling, profile/dataset behavior, continuous slider logic, quick-model first-install/update preservation, track selection, test-mode calculations, commands and flow behavior. They do not establish recognition accuracy on new people.

## Earlier native-control evidence

A local development report dated 2026-11-10 records native command execution and state readback for: independent A/B play/pause; AB transport/seek; bounded per-deck seeking; replacing a playing deck while the other continues; loop-duration update after replacement; waveform reads; track/linked volume; three-band EQ and undo; reverb/delay/chorus and supported undo; a tone preset; and applied playback rates of 1.1× and 0.9×. This is historical integration evidence, not a fresh test of this release archive or a listening-quality evaluation.

That report did not verify physical eye gestures through the entire browser-to-audio path, human listening quality, system-loopback output, end-to-end latency, a fresh installation, or every library import/delete case. Arbitrary WAV files did not supply BPM/Key tags, so missing metadata must not be reported as measured musical analysis.

## Not verified here

- Actual human gesture recognition or camera/session-baseline acquisition in this release check.
- Real audio output, end-to-end eye-to-SoundCraft command latency, or any clinical/accessibility benefit.
- A clean native SoundCraft build, cross-platform execution, or availability of every pinned Cargo dependency.
- Matching-condition Quick Experience versus personalized-mode user-study performance.
- Reproduction of the authors' 10-participant, 296-trial/224-correct aggregate study result.

Minimum follow-up: start the compatible SoundCraft build with its synthesized demo and local control port; start Python; connect and bind A/B; test play/pause, small volume/EQ/effect changes and playback rate while listening; then use a fresh webcam session for Quick Experience and personal calibration separately. Check observed outcomes and preserve any errors rather than treating a successful request as proof of audible output.
