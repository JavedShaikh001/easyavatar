# EasyAvatar

Turn your webcam face into an anime-style 3D character, VTube with it live, and export it for games and streaming apps.

- **Scan** – look at the webcam; EasyAvatar reads your face shape (face length, jaw, eyes, brows, nose, mouth) and your skin, hair and eye colours, and builds a matching character. Everything runs on your computer; no image is uploaded. (For the realistic style, the face photo is stored inside your saved `.easyavatar` file and exported avatar, so share those only with people you trust.)
- **Two styles** – *Anime* (a VRoid-like stylised character whose face is shaped and coloured from your scan) or *Realistic* (your own scanned 3D face shape with your webcam photo as its skin, on a natural-proportion body). Switch any time in the Scan or Face tab.
- **Customise** – sliders for face and body, 4 hairstyles × 3 bangs, outfits (T-shirt / long sleeve / tank, pants / shorts / skirt) with colour pickers, undo (Ctrl+Z), save/open `.easyavatar` files, "Surprise me".
- **VTube** – your character copies your head, blinks, eyes and mouth from the webcam. Green/blue screen backgrounds, expression hotkeys (1–5, 0 to reset), and a "hide controls" mode for OBS window capture.
- **Export** – `.vrm` (VRM 0.x: humanoid rig, 18 expressions incl. lip-sync vowels and blinks, spring-bone hair, MToon toon shading) for VSeeFace, Warudo, VTube Studio, VRChat converters and Unity + UniVRM; `.glb` for Unity (glTFast), Blender, Godot.

## Install

| System  | File |
|---------|------|
| Windows | `EasyAvatar-Setup-1.0.0.exe` – double-click. Windows SmartScreen may say "Windows protected your PC" because the installer isn't code-signed yet: click **More info → Run anyway**. |
| macOS   | `EasyAvatar-1.0.0.dmg` (built by GitHub Actions) – drag to Applications. Unsigned for now: the first time, right-click the app → **Open**. |
| Linux   | `EasyAvatar-1.0.0.AppImage` (make it executable, then run) or `easyavatar_1.0.0_amd64.deb` (`sudo apt install ./easyavatar_1.0.0_amd64.deb`). |

The first time you use the camera, EasyAvatar needs Google's MediaPipe face-tracking model (about 4 MB). Installers built by GitHub Actions include it; otherwise the app downloads it once and keeps it.

## Develop

```bash
npm install
npm start            # build the renderer and launch the app
npm test             # geometry sanity checks
npm run fetch-model  # bundle the face model into app/models
npm run dist:win     # or dist:mac / dist:linux
```

Push a tag (`git tag v1.0.0 && git push --tags`) and `.github/workflows/build.yml` builds all three installers and attaches them to a GitHub Release.

### How it works

- `src/avatar/builder.js` builds the whole character in code: skeleton, lofted body/limbs/clothes, an anime head, strand-based hair with spring-bone chains, and face "decals" (eyes, brows, mouth) with morph targets for expressions.
- `src/avatar/exporter.js` writes VRM 0.x with three.js' GLTFExporter plus a plugin for the VRM extension. The app shows every edit by exporting and re-loading the VRM with `@pixiv/three-vrm`, so what you see is exactly what you export.
- `src/scan.js` measures face proportions from MediaPipe landmarks and samples colours; `src/vtube.js` maps blendshapes and head pose onto the VRM.
- Electron (`electron/main.cjs`) serves the app over a private `app://` scheme, grants only camera access, and does file save/open.
