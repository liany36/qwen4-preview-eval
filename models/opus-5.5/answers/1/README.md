# 任务 1 · 平面图 → 可摆家具的三维房间 → 导出

## 怎么跑（3 行）

1. 把本目录丢到任意静态服务器（或公网静态站）上，打开 `index.html`：页面会 `fetch('floorplan.svg')` 现场解析。
2. 直接双击 `index.html` 也能用（需要联网加载 CDN 上的 three.js 0.160）。但本地双击时浏览器不允许页面读同目录文件，此时页面会改用内嵌的同一份图纸，并显示黄色提示条。改过 `floorplan.svg` 的话，用右上角"载入图纸…"选它，或直接把 svg 拖进窗口。
3. 想换图纸不用刷新页面：点"载入图纸…"或拖入 .svg 文件；也可以用 `index.html?plan=另一张.svg`（仅限 http 打开时）。

## 功能对照

| 要求 | 实现 |
|---|---|
| 解析尺寸 | 收集所有 `class="wall"` 和 `class="door"` 元素，取包围盒除以 100，标题栏显示 `总宽 6.00 m × 总深 4.00 m`。把右墙 x 改成 800 重新载入，会显示 7.00 m（已测） |
| 墙 / 门 / 窗 | 墙高 2.8 m、厚 0.1 m，沿中心线生成。和墙共线的门洞段会被从墙上**减掉**，所以即使墙线画穿了门洞，门洞处也不会有墙。窗是半透明蓝色薄片，贴在墙面上，离地 0.9–2.2 m |
| 家具 | 办公桌、椅子、文件柜、会议桌，全部用 BoxGeometry 或 CylinderGeometry 程序化生成 |
| 放置 | 把左侧面板里的家具拖到地面，拖动过程中有半透明预览；单击面板条目会直接放到房间中央 |
| 拖动 | 在场景里按住家具拖动，松手后位置保留；默认开启 10 cm 网格吸附（可关闭） |
| 微调 | 方向键 ±10 cm，方向跟随当前视角；`R` 旋转 15°，`Shift+R` 反向旋转；`Delete` 删除 |
| 撤销 | "撤销全部"清空所有家具并复位相机，回到刚导入图纸时的状态 |
| 导出 | "导出 GLB"生成 `out.glb`（glTF 2.0 binary，three.js GLTFExporter）；"导出 OBJ + MTL"生成 `out.obj` 和 `out.mtl`（自写导出器，坐标已乘世界矩阵）。导出前先弹出"将导出 N 个物体"的清单 |
| 提示 | 家具穿墙、超出房间、互相叠放时，红框高亮并在左下角提示（椅子塞到桌下不算叠放）。只提示，不阻止操作 |

本目录里的 `out.glb`、`out.obj` 和 `out.mtl` 是样例导出：页面用 `#selftest` 模式，通过 `app.addFurniture` 放了 2 桌 2 椅、1 张会议桌、1 个柜子，再由无头 Chrome 导出。实际使用时请点页面上的导出按钮。

样例文件结构：根节点 `room` 下有 `structure` 和 `furniture` 两组。`structure` 里是 `floor`、9 段墙 `wall_01..09`、3 扇窗 `window_01..03`；`furniture` 里每件家具是一个组（如 `desk_01`），下面是各个部件网格（如 `desk_01_top`）。单位是米，Y 轴朝上。

## Unity 导入

- **OBJ（推荐给验收用，Unity 原生支持）**：把 `out.obj` 和 `out.mtl` 一起拖进 `Assets/`。Unity 会按 `mtllib` 读取材质颜色和窗户透明度。Model 导入设置里 Scale Factor 保持 1（文件本身就是米制，Unity 里 1 单位 = 1 m）。
  - Unity 导入 OBJ 时会翻转 X 轴，把右手坐标系换成左手坐标系。这是正常现象，布局不会镜像。
  - 窗户的透明度：Built-in 管线下 MTL 的 `d` 会映射到 Standard 材质。在 URP/HDRP 下，需要在 Materials 页签选 Extract Materials，再把窗户材质的 Surface Type 改成 Transparent。
- **GLB**：Unity 原生**不支持** glTF。要先装 glTFast（Package Manager → Add package by name → `com.unity.cloud.gltfast`），然后把 `out.glb` 拖进 Assets，节点层级和 PBR 材质都会保留。

## UE5 导入

- **OBJ**：UE5 原生支持，在 Content Browser 里选 Import，选择 `out.obj`。UE 用厘米，所以导入选项里 Import Uniform Scale 要设 **100**。如果模型是躺倒的，把 Import Rotation 设为 X=90。建议去掉 Combine Meshes，这样每件家具保持为独立的网格。
- **GLB**：UE5 **原生不吃 glTF**，需要以下两种方式之一：
  - 在 Edit → Plugins 里启用 Epic 自带的 **glTF Importer** 插件（默认未启用），重启后直接导入 `.glb`。
  - 用 **Datasmith**：启用 Datasmith Importer 插件后，通过 Datasmith 导入 glTF，可以保留层级。
  - glTF 路线会自动把米换算成厘米，并处理 Y-up 到 Z-up 的转换。
- **两者差异**：Unity 吃 OBJ 不用装任何东西，吃 glTF 要装 glTFast 包。UE5 吃 OBJ 也不用装东西，但要手动处理单位（×100）和轴向；吃 glTF 要启用 glTF Importer 插件或走 Datasmith。如果要保留层级和 PBR 材质，两边都推荐走 glb 路线；如果要零依赖验收，用 obj。

## 已知限制

- 解析器支持 `line`、`rect`、`polyline`、`polygon`，不支持 `path` 和 `transform` 属性。
- 碰撞检测用的是家具旋转后的轴对齐包围盒，旋转成斜角时判定会偏保守。
- 窗户没有在墙上开洞，只是半透明面片（brief 允许）。
