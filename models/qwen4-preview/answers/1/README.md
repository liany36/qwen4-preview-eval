# 任务 1 · 图纸 → 3D 房间 → 导出

## 怎么跑（3 行）

1. 静态服务器（推荐）：在本目录执行 `python -m http.server 8000`，浏览器开 `http://localhost:8000/`。
2. 或直接双击 `index.html`：file:// 下自动使用 `embedded.js` 里内嵌的同一份图纸（仍走解析器算尺寸）；改图纸用「载入新图纸」按钮选任意 SVG，不用刷新。
3. 左侧面板拖桌子/椅子/柜子进场景；左键拖家具（0.1 m 吸附），空白处拖 = 转视角；方向键 ±10 cm，R 转 15°，Delete 删除；「撤销」清空家具回到刚导入状态；两个导出按钮分别下载 `out.glb` 和 `out.obj`+`out.mtl`。

尺寸 `总宽 6.00 m × 总深 4.00 m` 是运行时从 `assets/floorplan.svg` 的 `class="wall"` 线段包围盒算的（100 units = 1 m），改墙坐标重跑会跟着变。门洞由 `class="door"` 线段与墙共线求交后从墙段里切掉；窗是半透明蓝色面片贴墙（未开洞，符合 brief）。

随附的 `out.glb` / `out.obj` / `out.mtl` 是页面真实导出的文件（含 3 件示例家具：桌子、椅子、柜子各一），不是手写的。

## Unity 导入（用 out.obj，别用 glb）

1. 把 `out.obj` 和 `out.mtl` **放进同一个文件夹**再拖进 Unity 的 Assets（mtl 提供材质颜色，obj 里 `mtllib out.mtl` 是相对引用）。
2. Unity 原生导入 OBJ：选中模型，Inspector 里 Scale Factor 保持 1（场景单位就是米），需要时勾 Generate Lightmap UVs。
3. Unity **不原生认 glb**；要用 `out.glb` 需先装 glTFast（Package Manager → Add package by name：`com.unity.cloud.gltfast`）再导入。本任务按 brief 以 obj 为准。
4. 中文节点名（如 `桌子_1`）Unity 支持；材质名是 ASCII。

## UE5 导入

- **UE5 原生不吃 glTF**（截至 UE 5.4 的 Interchange 默认管线对 .glb 支持不完整/需开启插件）。两条路：
  1. 装 **glTF importer 插件**（或用 Epic 的 Datasmith glTF Exporter 生态里的导入器）后导入 `out.glb`；
  2. 更稳的路：用 Blender 打开 `out.obj` 再走 **Datasmith** 导出 `.udatasmith` 进 UE5，或直接 Blender 导 FBX。
- OBJ 也可经 Blender/DCC 转一道进 UE5；UE5 的 Interchange 对 OBJ 支持有限，别直接拖。
- 单位：UE5 是厘米，导入时按 1 m = 100 cm 缩放（Datasmith/FBX 管线通常自动处理，OBJ 手动设 100）。

## 差异一句话

Unity 原生 OBJ、glb 要 glTFast；UE5 两者都不算原生一等公民，glTF 要插件、OBJ 建议经 DCC/Datasmith 转。

## 已知边界

- 碰撞提示（穿墙/叠放/出界）只标红警告，不阻止放置和导出——brief 只要求提示。
- 撤销 = 清空全部家具（brief 定义如此），不是逐步 undo。
- file:// 下 fetch 外部 SVG 会被浏览器拦，所以内嵌了一份同源副本；静态服务器下永远以 `assets/floorplan.svg` 为准。
