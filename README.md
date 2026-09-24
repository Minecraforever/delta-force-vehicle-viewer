# Delta Force Vehicle Viewer

Interactive 3D reference for **Delta Force** (三角洲行动) vehicles — hitboxes, collision
volumes and per-weapon damage — exported from the game client (build `1.101.37117.36`).

Static site. No build step, no network access, three.js vendored locally. The interface is in Chinese.

**Live: <https://minecraforever.github.io/delta-force-vehicle-viewer/>**

## Run locally

| Platform | How |
| --- | --- |
| macOS | double-click `start-mac.command` |
| Windows | double-click `start-windows.cmd` |

Either script serves the site read-only on `127.0.0.1` (first free port in 8777–8790) and opens
your browser. Closing the window stops it. Nothing to install.

Any static server works too: serve the repository root and open `/docs/index.html`.
Do not open the HTML file directly — ES modules and `fetch` require `http://`.

## Layout

```
docs/               the site, and the GitHub Pages source
  index.html        page
  app.js style.css  front end
  vendor/           three.js r160 + loaders and controls
  data/             vehicle data: hitboxes, parts, collision volumes, damage tables
  models/<name>/    18 vehicles as .glb meshes with .jpg textures
start-mac.command   macOS launcher
start-windows.cmd   Windows launcher
start-windows.ps1   its server implementation
```

## Assets and copyright

Every model, texture and data table under `docs/` was exported from the game client
(build `1.101.37117.36`). They are **not** covered by the MIT license and remain the property
of their owners — Delta Force (三角洲行动) is developed by Team Jade (TiMi Studio Group,
Tencent) and published by Tencent.

This is an unofficial project, not affiliated with or endorsed by Tencent. The assets are
included for personal, non-commercial study and research only. If you are a rights holder and
would like something removed, please open an issue and it will be taken down.

## License

The source code (page, scripts, launchers) is MIT — see [LICENSE](LICENSE). Game assets are excluded.

---

Made by Minecraforever · Bilibili [@Minecraforever](https://space.bilibili.com/670174785)
