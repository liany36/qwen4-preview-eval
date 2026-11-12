# Three tasks, five models: raw materials from one comparison

This repository contains the raw materials from one model comparison: three tasks, five models (one was added on 2026-11-12), each model ran each task exactly once, with no human cleanup afterwards. The companion article is on WeChat (link TBD).

## Layout

```
tasks/     the three task briefs, plus the input files they need
models/    each model's raw answers and its own delivery notes
scoring/   the six-dimension score tables, the leaderboard, and 11 screenshots
```

## The three tasks

**Floor plan to digital twin.** Each model gets an SVG floor plan and has to parse it into a matching digital twin scene. The engine has to provide ready-made furniture — desks, chairs, filing cabinets — that the model can drag around and position. It then has to export the finished room as a model file that works in Unity and UE5: Unity reads obj and fbx natively, glb needs glTFast; UE5 does not read glTF natively and needs a plug-in or Datasmith. The brief lists two bonus items: warn when furniture clips through a wall or overlaps, and load a new floor plan without reloading the page. The task tests tool use and format discipline.

The brief is in `tasks/task-1-brief.md`.

**Backend repair.** A half-finished orders backend left behind by a contractor who walked away. I planted eight common problems in the orders module; the model has to decide whether the code can ship and give a fix list plus a plan. The task tests how well the model reads backend code — and whether it invents problems that are not there.

The brief is in `tasks/task-2-brief.md`.

**One-shot render.** The model picks a rocket launch or a volcanic eruption and has to render enough particles and smoke. To push the model, the brief requires the most spectacular moment to appear within 10 seconds of opening the page, with no interaction. The inviter asked for this task.

The brief is in `tasks/task-3-brief.md`.

The briefs use the relative paths from the original evaluation setup (each model folder had its own `_shared/` copy); this repository keeps the three input files under `tasks/assets/`.

## The five models

Five models took part: Qwen4 preview, Opus 5.5, DeepSeek V4.1 Flash 1017, Grok-bot 4.7, and Qwen4 online preview (added on 2026-11-12). They used the same prompts and the same runtime, each task ran once, and the tasks covered engineering, backend and frontend work.

- **Qwen4 preview.** 86.0 total, third place. First on the render task; the only model among the original four that chose the volcano.
- **Opus 5.5.** 86.3 total, second place. Best on the floor-plan and backend tasks among the original four; lost points on the render task when its upper stage flew out of frame. Its pages load three.js from a CDN and need a network connection.
- **DeepSeek V4.1 Flash 1017.** 84.6 total, fourth place. The steadiest delivery; its line-number callouts were the most accurate.
- **Grok-bot 4.7.** 78.7 total, fifth place. The most designed-looking UI, but the lowest completeness and engineering scores on both the floor-plan and backend tasks.
- **Qwen4 online preview (added 2026-11-12).** 88.0 total, first place. 89.5 on the floor-plan task, 92.5 on the backend task and 81.5 on the render task — stronger than the original Qwen4 preview on the first two, weaker on the render.

`models/` holds one folder per model, and all five folders have the same layout:

- `answers/1/`: the floor-plan answer, a web page you can open directly.
- `answers/2/`: the backend answer, with `FINDINGS.md` (the audit report) and `patched/orders.js` (the fixed code).
- `answers/3/`: the render answer, a web page you can open directly.
- `DELIVERY.md`: the model's own delivery notes, including what it admits it did not finish.

The `out.glb`, `out.obj` and `out.mtl` files in the web pages are sample exports produced by the model itself.

## How the scores were produced

Each task is worth 100 points, split across six dimensions: completeness, one-shot success, engineering structure, interface, time and resource use. The six dimensions carry different weights on each task; the exact weights and every model's scores are in `scoring/scores.md`.

The total is the three task scores weighted 40/30/30.

Leaderboard: Qwen4 online preview scored 88.0, Opus 5.5 86.3, Qwen4 preview 86.0, DeepSeek V4.1 84.6, Grok-bot 4.7 78.7.

## Added: Qwen4 online preview (2026-11-12)

On 2026-11-12 the same three tasks were re-run once with Qwen4 online preview. It scored 89.5 / 92.5 / 81.5, 88.0 weighted. Raw answers are in `models/qwen4-online-preview/`, details in `scoring/qwen4-online-preview.md`. The other four models' scores are unchanged.

## Scope and caveats

- Every score here is my own subjective judgment. I wrote the tasks, each model ran each task once, and I chose the weights. This is a careful trial record, not a benchmark from a professional evaluation lab.
- The test was done under an invitation: the inviter gave me early access to Qwen4 preview and reviewed the article before I published it. This repository only contains raw materials and scores, not the conclusions.
- All screenshots are single first frames; animated outputs look different in motion.

## Use

You may read, review and cite these materials freely; please credit the source when republishing.
