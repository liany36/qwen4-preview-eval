# 任务 1 · 图纸 → 三维房间 → 导出

## 怎么跑（3 行）

1. 直接双击 `index.html` 即可（`file://` 下会自动退回页面内联的同一份 SVG 源码解析）。
2. 想走真正的 `fetch('floorplan.svg')` 路径，在本目录起任意静态服务器：`python -m http.server 8000`，然后开 `http://localhost:8000/`。
3. 不需要 `npm install`、不需要构建。three.js 与两个导出器都放在 `vendor/` 里本地引用，零外网依赖。

## 操作

| 动作 | 做法 |
|---|---|
| 放家具 | 从左侧面板**拖**进场景；或**点**一下条目，自动找最近的空位 |
| 移动已放家具 | 左键按住家具拖动，松手位置即保留（默认 10cm 网格吸附，可关） |
| 微调 | 选中后 `←/→/↑/↓` 每次 10cm，`R` 每按一次旋转 15°，`Del` 删除 |
| 撤销到初始 | 顶部「清空（回到刚导入）」清掉所有家具（图纸不动） |
| 换图纸 | 顶部「载入新图纸」选一个 `.svg`，不刷新页面直接重建 |
| 导出 | 「导出 GLB」得到 `out.glb`；「导出 OBJ」得到 `out.obj` + `out.mtl` |

## 图纸解析规则（这是会被改坐标重跑的部分）

- `class="wall"` 的 `<line>` 是墙，按**中心线**、墙厚忽略不计；沿轴向按 `class="door"` 求差，**门洞处不留墙**。
- `class="window"` 沿墙贴一块半透明蓝色面片（不开洞，符合要求）。
- 单位：`100 SVG units = 1 m`，换算写在 `js/floorplan.js` 的 `unitsPerMeter`；界面上的「总宽 / 总深」是墙线包围盒**算出来的**，不是常量。
- 坐标原点取墙线包围盒中心，SVG 的 y 轴映射到 three.js 的 +z，所以俯视图与图纸方向一致。
- 本图纸解析结果：`6.00 m × 4.00 m`，9 段墙（3 处门洞已断开）、3 扇窗、3 个门洞。

## Unity 导入

- **首选 `out.obj` + `out.mtl`**：把两个文件一起拷进 `Assets/`，Unity 会按 MTL 自动建材质（Standard shader，颜色对得上，`d` 会映射成透明度）。FBX 需要你自己在 Unity 里另存，OBJ 是 Unity 原生支持的。
- `out.glb` 需要装 **glTFast**（UPM：`com.unity.cloud.gltfast`）才能导入；Unity 本身不认 glTF。
- 尺度：1 个 three.js 单位 = 1 米，Unity 侧不用改 Import Scale。墙高 2.8，地面在 y=0。

## UE5 导入

- **UE5 原生不吃 glTF**，`out.glb` 直接拖进去会被拒。两条路：
  1. **Datasmith**（推荐）：装 `Datasmith importer`，或先把 OBJ 转成 FBX（Blender 里 `File → Import → Wavefront (.obj)` 再导出 FBX），UE5 再导 FBX。
  2. **glTF 插件**：ue 市场里的 `glTF Importer` 插件可以直读 glb，但材质需要重建（插件只保证几何与 UV）。
- **单位差异（最容易翻车的一条）**：UE5 默认 1 单位 = 1 厘米，Unity 默认 1 单位 = 1 米。所以同一个 OBJ 进 UE5，如果不勾 `Convert Scene Unit`（或在导入选项里把 `Import Uniform Scale` 设成 100），房间会缩成 6 厘米见方。UE5 导入时确认 `Import Uniform Scale = 100`。
- UE5 侧坐标轴：OBJ 进来默认会做 Y-up → Z-up 的转换，房间是躺平的；如果发现墙立不起来，检查有没有关掉 `Convert Scene`。

**一句话差异**：Unity 认 OBJ/FBX、1 单位 = 1 米；UE5 认 FBX/Datasmith、1 单位 = 1 厘米，且不认 glTF。同一份 `out.obj` 两边都能吃，但 UE5 要 ×100。

## 文件

```
index.html            入口
floorplan.svg         输入图纸（同目录，fetch 用）
js/floorplan.js       SVG 解析（浏览器 + node 共用）
js/scene-builder.js   房间 / 家具几何，程序化生成
js/app.js             交互、拖拽、吸附、碰撞、导出
tools/build-exports.js  node 侧重新生成下面三个导出件
vendor/               three.js r128 + OrbitControls / GLTFExporter / OBJExporter
out.glb               预生成导出件（对应示例布局）
out.obj / out.mtl     预生成导出件（Unity 用）
```

`out.obj/.mtl/.glb` 是用 `tools/build-exports.js` 跑同一套 `js/scene-builder.js` 生成的，
与页面里点「导出」按钮得到的几何、材质名完全一致（页面导出会包含你当时摆的所有家具）。

## 已知取舍

- 窗不开洞，只贴面片（按任务书允许）。
- 门洞不生成门扇/门框，只有缺口。
- 家具穿墙/重叠时给红色描边 + toast，拖拽松手会**退回原位**；点击面板放置则是自动找空位。
