# Three tasks, four models: raw materials from one comparison

This repository contains the raw materials from one model comparison: three tasks, four models, each model ran each task exactly once, with no human cleanup afterwards. The companion article is on WeChat (link TBD).

## Layout

```
tasks/     the three task briefs, plus the input files they need
models/    each model's raw answers and its own delivery notes
scoring/   the six-dimension score tables, the leaderboard, and 8 screenshots
```

## The three tasks

1. **Floor plan to 3D room.** Give the model an SVG floor plan; it has to parse the walls, doors and windows, build a 3D room you can furnish, and export a file that Unity and UE5 can open. The brief is in `tasks/task-1-brief.md`.
2. **Broken backend handover.** Give the model an orders service left behind by a vanished contractor; it has to decide whether the service can take payments tomorrow and fix what must be fixed. The brief is in `tasks/task-2-brief.md`.
3. **One-shot render.** The model picks either a rocket launch or a volcanic eruption and builds a scene that looks good the moment it opens. The brief is in `tasks/task-3-brief.md`.

## The four models

`models/` contains `grok-4.7`, `opus-5.5`, `deepseek-v4.1` and `qwen4-preview`. Each folder has the same layout:

- `answers/1/`: the floor-plan answer, a web page you can open directly.
- `answers/2/`: the backend answer, with `FINDINGS.md` (the audit report) and `patched/orders.js` (the fixed code).
- `answers/3/`: the render answer, a web page you can open directly.
- `DELIVERY.md`: the model's own delivery notes, including what it admits it did not finish.

The `out.glb`, `out.obj` and `out.mtl` files in the web pages are sample exports produced by the model itself.

## How to open the pages

Most pages open by double-clicking. A local server is safer, because browsers do not let a page read files from the same folder when it is opened as a local file:

```
cd models/qwen4-preview/answers/1
python -m http.server 8000
```

Then open `http://localhost:8000/` in a browser.

One exception: Opus loads three.js 0.160 from a CDN and needs a network connection. The other three models keep three.js in their local `vendor/` folder.

## How the scores were produced

Each task is worth 100 points, split across six dimensions: completeness, one-shot success, engineering structure, interface, time and resource use. The six dimensions carry different weights on each task; the exact weights and every model's scores are in `scoring/scores.md`.

The total is the three task scores weighted 40/30/30.

Leaderboard: Opus 5.5 scored 86.3, Qwen4 preview 86.0, DeepSeek V4.1 84.6, Grok-bot 4.7 78.7.

## Scope and caveats

- Every score here is my own subjective judgment. I wrote the tasks, each model ran each task once, and I chose the weights. This is a careful trial record, not a benchmark from a professional evaluation lab.
- The test was done under an invitation: the inviter gave me early access to Qwen4 preview and reviewed the article before I published it. This repository only contains raw materials and scores, not the conclusions.
- All screenshots are single first frames; animated outputs look different in motion.

## Use

You may read, review and cite these materials freely; please credit the source when republishing.
