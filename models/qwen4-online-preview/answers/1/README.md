# 任务 1 · 图纸 → 3D 房间 · 家具摆放与导出

## 怎么跑（3 行）

1. 双击 `index.html` 即可打开（file:// 下自动使用内嵌图纸副本）；或在本目录起任意静态服务器，例如 `python -m http.server 8134`，访问 `http://127.0.0.1:8134/answers/1/index.html`。
2. 通过静态服务器访问时，优先 fetch 外部 `floorplan.svg`——改墙坐标后刷新即生效，尺寸/墙段全部实时重算。
3. 左侧面板拖（或点击）家具进场景；点击选中后方向键 ±10 cm、R 旋转 15°、Delete 删除；「撤销」回到刚导入图纸的状态；两个导出按钮分别下载 `out.glb` 和 `out.obj + out.mtl`。

仓库里已附带一份用默认图纸 + 5 件家具生成的 `out.glb` / `out.obj` / `out.mtl`（glTF 2.0，51 节点 / 41 网格，已通过结构校验），供 Unity 侧直接验收；页面里随时可以重新导出。

## 功能对照

- 解析 SVG（line / rect / polyline / polygon / path，支持嵌套 transform 与整图旋转），100 单位 = 1 m，界面显示从图纸算出的 `总宽 × 总深`。
- 门洞：与墙共线的 `class="door"` 区间会从墙上减掉（v2 图纸里贯穿整屋的内墙就是靠这一步断开的）；门洞处只留红色门槛标记，没有墙。
- 墙高 2.8 m；窗是半透明蓝色面片贴墙（不开洞）。
- 家具全部程序化 Box 几何：桌子 1.2×0.6×0.75、椅子 0.45×0.45×0.9、柜子 0.9×0.45×1.8（m）。
- 碰撞：2D OBB 对墙线段和其他家具检测；冲突时红色高亮、松手回退到上一个合法位置；面板放置冲突时就近螺旋搜索空位。
- 拖拽吸附 0.1 m 网格（可关）；导出前侧栏实时显示「将导出 N 个物体」清单。
- 「载入新图纸」支持本地 SVG 文件，无需刷新；「载入 v2 示例」演示 rect 外墙 + 折线内墙 + 整图旋转 90° 的图纸。

## Unity 导入（用 out.obj + out.mtl）

1. 把 `out.obj` 和 `out.mtl` 一起拖进 Unity 的 Assets 目录（两个文件必须同目录，obj 第一行 `mtllib out.mtl` 引用它）。
2. Unity 原生支持 OBJ：导入后把模型拖进 Scene 即可。单位是米（1 unit = 1 m），Y 轴向上，与 Unity 一致，无需缩放。
3. 若材质颜色不对，在 Inspector 里把导入材质的 Shader 换成 Standard/URP Lit；OBJ 的 `d`（透明度）不会自动变成透明材质，窗玻璃需要手动把 Rendering Mode 设为 Transparent。
4. glb 不是 Unity 原生格式：要用 `out.glb` 需先装 glTFast（Package Manager → Add package by name：`com.unity.cloud.gltfast`），再拖入 glb。本交付以 obj 为准。

## UE5 导入（用 out.obj，或 glb + 插件）

1. UE5 **原生不吃 glTF**。两条路：
   - 推荐：Content Browser → Import，选 `out.obj`（Datasmith 也支持 OBJ/FBX 路线）。导入时勾选 Combine Meshes 可按需合并；单位换算选厘米（UE 1 uu = 1 cm，模型是米制，导入缩放设 100，或导入后统一 Scale 100）。
   - 或者装 glTF 导入插件（如社区 glTF for Unreal / Datasmith glTF  exporter 链路）后再导 `out.glb`。
2. 与 Unity 的差异：Unity 原生认 OBJ、米制、Y-up，直接拖入即可；UE5 不原生认 glTF（要插件或走 Datasmith/OBJ），且是厘米制、Z-up，导入时要处理单位与轴向（OBJ 导入器会自动转轴向，单位要自己给 100 倍）。

## 已知限制

- file:// 下浏览器禁止 fetch 本地文件，此时用 index.html 内嵌的图纸副本；改外部 SVG 坐标重跑请走静态服务器（或页面里「载入新图纸」选文件）。
- path 的曲线命令按端点折线近似（本图纸只有直线段，无影响）。
- 撤销是「清空全部家具回到刚导入状态」，不是逐步 undo（按任务书第 6 条实现）。