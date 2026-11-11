# SoundCraft integration setup

The browser demonstration and webcam recognition work without SoundCraft. Native music processing requires the GazeDeck-compatible SoundCraft integration snapshot supplied in `soundcraft-runtime/deck-live-load-20261108/source.zip`. It is based on SoundCraft 0.17.1 and is not an official upstream release. Do not assume that an unrelated upstream binary implements the added commands.

## Build and launch

1. Extract the source ZIP to a development directory.
2. Install a Rust toolchain and the native linker/platform dependencies. The included upstream documentation recommends Rust **1.95 or later** for the desktop UI; the core workspace declares a minimum of **1.90**. On Windows a working MSVC C/C++ build toolchain is needed. On Linux install ALSA development headers, along with the UI dependencies required by Cargo. The first build downloads Cargo and pinned Git dependencies.
3. From the extracted directory containing `Cargo.toml`, run:

   ```sh
   cargo build --release -p soundcraft
   ```

4. Start its synthesized demo and enable local control:

   ```powershell
   # Windows
   .\target\release\soundcraft.exe --demo --control 7979
   ```

   ```sh
   # macOS / Linux
   ./target/release/soundcraft --demo --control 7979
   ```

   To use a saved project, supply its path instead of `--demo`. Do not open the private project used during development: it is not distributed.

5. In a separate terminal, start GazeDeck: `python serve.py`. Open its SoundCraft connection panel, connect, choose A and B tracks, and enable real control.

The integration source is provided for reproducibility; this public packaging task has **not** completed a fresh native compilation or a fresh listening test. See `VERIFICATION.md` for what was checked.

## Connection boundaries

The page uses same-origin HTTP endpoints under `/api/soundcraft/`. `serve.py` serves those endpoints and translates allowlisted operations to a **localhost TCP JSON-lines protocol**. Port 7979 is not an HTTP website. Both the browser service and native control service should remain local. `serve.py --soundcraft-port 7979` selects the native port explicitly; `serve.py 9000` changes only the browser service port.

The native application must already be running. Python does not install or launch SoundCraft. Binding records project/session/track identity. Failed status reads may recover after identity checks, but write commands are not automatically replayed.

Imported web-library audio is stored on the local machine outside the repository. Import only material you have rights to use. The repository contains neither those files nor participant recordings. A native build may synthesize its own demo material from code.

## Source and licensing

The archive retains upstream MIT/Apache license texts, NOTICE, asset attribution and dependency lockfile. The public package removes the restricted ArtCraft logo/mark files and one machine-specific development document and replaces its README with an integration-specific guide. Native Rust files and Cargo build inputs are unchanged from the local integration snapshot. Upstream notices do not grant rights to separately authored GazeDeck additions; those reuse terms remain pending.
