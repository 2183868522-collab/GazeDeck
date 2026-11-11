# Data scope and privacy

## Published package

`data/quick-model-default.v1.json` uses format `gazedeck-quick-model/v1`; its active and initial model are `builtin-quick-model-v2`. The format filename does not mean the retired model version is distributed.

- 14 generic source sets, named `builtin-source-01` through `builtin-source-14`.
- 837 normalized/resampled numerical source samples, with generic sample keys, labels and durations.
- 168 active temporal templates: 24 each for Look Left, Look Right, Look Up, Look Down, Long Blink, Double Blink and Natural.
- 20 frames per sequence, 25 numeric features per frame.
- Classifier configuration: resample length 20, DTW band 3, k = 3, rejection factor 2, duration weight 1.
- Stored offline candidate/evaluation information. These records are not the paper's participant-study results or a latency benchmark.

Labels and generic source display names retain their Chinese internal representation for compatibility with the existing code; the English UI translates them. Source-set count must not be interpreted as the number of distinct research participants. The old removed source and its seven-template contribution are not retained in this active package.

The project owner explicitly authorized public distribution of the model and 837 de-identified feature samples. This release does not claim that code alone can verify consent documentation or establish the provenance of every historical recording. No third-party research dataset is identified as a source of this package. Any future dataset addition requires its own authorization and license review.

## Removed or excluded

No raw participant face/eye images, webcam videos, personal profile exports, full individual baseline records, names, emails, device labels, private user IDs, local filesystem paths, imported music, private SoundCraft projects, credentials, caches, local runtime installations or old Git history are intentionally included. Generic source/sample IDs replace personal labels; sample session IDs are empty and synchronization timestamps are zero.

The release is prepared in an independent directory and starts a new Git history. This avoids carrying historical private files from earlier development repositories. Third-party test fixtures may contain generic paths such as `/home/u`; MediaPipe generated code uses a virtual Emscripten home directory. These are not participant machine paths.

De-identified derived eye features are still potentially linkable data, not guaranteed anonymous data. The data reuse license remains pending; public availability does not authorize unrestricted redistribution or reuse. No facial photographs are provided as sample inputs.

## Runtime storage

Personalized mode stores local profiles/samples/settings in browser storage. Quick Experience maintains separate model-manager state and a temporary runtime baseline. Entering Quick Experience does not overwrite personal samples or baselines. Exported files can contain sensitive features: inspect them before sharing. Webcam features are computed in the browser; SoundCraft control and library requests go to the user's local Python service.

User-authorized imported music is stored by the local service in its application-data directory. It is outside this source package. The `.gitignore` excludes common recording, export, cache, environment and imported-media paths; it is a guardrail, not a substitute for review before adding new files.
