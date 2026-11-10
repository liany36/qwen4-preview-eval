# 房间摆放

在 `answers/1` 起静态服务器再打开页面，不要直接双击，浏览器会拦截本地 ES module。例如 `python -m http.server 8131`，然后访问 `http://127.0.0.1:8131/`。

页面先读 `../../../_shared/assets/floorplan.svg`，失败再用同目录 `floorplan.svg`。总宽总深由墙、门、窗线段的坐标算出，100 SVG 单位 = 1 米，没有写死。

左侧把桌子、椅子、柜子拖进地面（或点一下放在中央）。左键拖动已放下的家具，方向键 ±10 cm，`R` 旋转 15°，「撤销到刚导入图纸」清掉家具。两个导出按钮分别下载 `out.glb`，以及 `out.obj` 和 `out.mtl`。

原点在平面包络中心，地面 y = 0，墙高 2.8 m，Y 轴向上，单位米。门洞处没有墙。同目录已放好空房间的 `out.glb` / `out.obj` / `out.mtl`，给引擎侧直接验。

## Unity

把 `out.obj` 和 `out.mtl` 放在同一目录，拖进 Assets。Unity 原生导入 OBJ，Scale Factor 保持 1。若朝向不对，在 Model 面板把 Up Axis 设为 Y。`out.glb` Unity 不原生读，需要装 glTFast。

## UE5

UE5 原生不吃 glTF，要装 glTF Importer 插件，或走 Datasmith。`out.obj` 用 Datasmith / Interchange 导入，不要把 glb 直接丢进 Content。

两者差别：Unity 原生吃 OBJ、不吃 glTF；UE5 原生不吃 glTF，必须插件或 Datasmith。
