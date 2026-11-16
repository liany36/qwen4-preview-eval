# 网页游戏：Saltline 与 SECTOR ZERO

第四题的两个完整 HTML 文件放在这里，可直接下载或在线试玩。

| 作品 | 说明 | HTML | 在线试玩 |
| --- | --- | --- | --- |
| Saltline | Fable 5.2 对照作品，港口突入 | [saltline/index.html](saltline/index.html) | [打开 Saltline](https://mrlian.ai/model-eval/qwen4-preview-eval/games/saltline/) |
| SECTOR ZERO | 千问4约四小时产出，科幻竞技场 | [sector-zero/index.html](sector-zero/index.html) | [打开 SECTOR ZERO](https://mrlian.ai/model-eval/qwen4-preview-eval/games/sector-zero/) |

**[画面对照、试玩入口与完整操作说明](https://mrlian.ai/model-eval/qwen4-preview-eval/games/)**

## 题目

提示词大意：

> 我希望你给我做一个能够达到 3A 游戏质感、有着不可思议的纹理细节和画质的射击游戏。

千问4约四小时交付 SECTOR ZERO。题目记录见 [task-4-brief.md](../tasks/task-4-brief.md)。

## 本地运行

在仓库根目录执行：

```sh
python -m http.server 8000
```

随后在浏览器打开：

- Saltline：<http://localhost:8000/games/saltline/>
- SECTOR ZERO：<http://localhost:8000/games/sector-zero/>

等加载完成，点击 **DEPLOY** 开始。SECTOR ZERO 通过 CDN 加载 Three.js，打开时保持联网。

| 操作 | 按键 |
| --- | --- |
| 移动 / 转向 | WASD / 鼠标 |
| 射击 / 瞄准 | 鼠标左键 / 右键 |
| 换弹 | R |
| 冲刺 / 蹲下 | Shift / C |
| 跳跃 | Space |
| 暂停与释放鼠标 | Esc；SECTOR ZERO 也支持 P |
| Saltline 中继交互 | E |
| SECTOR ZERO 手电 / 静音 | F / M |

如果 SECTOR ZERO 提示按住鼠标转向，可按住左键拖动。Saltline 的目标是切断三处中继后到船上撤离；SECTOR ZERO 的目标是清理四波敌人。

## 文件与来源

- 两份 HTML 按收到的原文件逐字节保存；预览站部署同一份文件。
- Saltline 原展示页：<https://pages.eiaserinnys.me/d/saltline-fable52/>。
- SECTOR ZERO 为本次千问4的答题产物。
- [manifest.json](manifest.json) 记录两个文件的 SHA-256，便于核对下载文件。
