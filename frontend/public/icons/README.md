# App icons & screenshots

Everything referenced from `vite.config.ts` (`manifest`) and `index.html` exists
in this repo and is a valid PNG, so the build and the install prompt work today.
The icons are **generated placeholders** — a clay-coloured house with a heart —
produced programmatically, not designed. Replace them when real artwork exists;
keep the filenames and pixel sizes identical so nothing else has to change.

## Required files

| File                               | Size      | Purpose                                       | Notes                                                                                                                               |
| ---------------------------------- | --------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `icons/icon-192.png`               | 192×192   | manifest, `purpose: any`                      | transparent corners, 22 % corner radius                                                                                             |
| `icons/icon-512.png`               | 512×512   | manifest, `purpose: any` + install splash     | same artwork, larger                                                                                                                |
| `icons/maskable-192.png`           | 192×192   | manifest, `purpose: maskable`                 | **full-bleed background**, artwork inside the central 80 % safe zone                                                                |
| `icons/maskable-512.png`           | 512×512   | manifest, `purpose: maskable`                 | same rules                                                                                                                          |
| `icons/apple-touch-icon-180.png`   | 180×180   | `<link rel="apple-touch-icon">`               | **no transparency, no rounded corners** — iOS applies its own mask and a transparent PNG shows as a black square on the Home Screen |
| `../favicon.ico`                   | 32×32     | browser tab (legacy)                          | PNG-encoded inside an ICO container                                                                                                 |
| `../favicon.svg`                   | vector    | browser tab (modern) + `mask-icon`            |                                                                                                                                     |
| `../screenshots/mobile-today.png`  | 1080×1920 | manifest `screenshots`, `form_factor: narrow` | **must be replaced with a real capture** before any store listing / richer install UI                                               |
| `../screenshots/mobile-tasks.png`  | 1080×1920 | manifest `screenshots`, `form_factor: narrow` | as above                                                                                                                            |
| `../screenshots/desktop-today.png` | 1280×800  | manifest `screenshots`, `form_factor: wide`   | as above                                                                                                                            |

## Still needed from a designer

1. **Real artwork** for the icon set above. The current mark is a stand-in.
2. **Real screenshots** — the three placeholder images are flat colour blocks and
   are the only assets here that would look wrong in front of a user. Capture
   them from the running app once the Today and Tasks screens exist.
3. Optional: a `1024×1024` master PNG so every size can be re-exported cleanly.

## Regenerating the placeholders

The generator is not checked in (it was a one-off script). If you need to
re-derive them, any tool works — the only hard constraints are the sizes above,
the maskable safe zone, and the opaque Apple touch icon.

## Palette

| Token              | Value     | Used for                                        |
| ------------------ | --------- | ----------------------------------------------- |
| clay (primary)     | `#c2643a` | icon background                                 |
| cream (background) | `#fdf8f2` | the house silhouette, light theme `theme-color` |
| warm charcoal      | `#211d19` | dark theme `theme-color`                        |
