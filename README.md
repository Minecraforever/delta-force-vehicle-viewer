<div align="center">

# 三角洲行动 · 全面战场载具可视化

从《三角洲行动》客户端解包数据生成的三维载具图鉴：
转着看车体，点开看部位命中盒和四种碰撞体，算清每种武器打每辆车到底掉多少血。

纯静态站点 · 不联网 · 不需要安装任何运行库

![数据版本](https://img.shields.io/badge/客户端版本-1.101.37117.36-blue)
![载具](https://img.shields.io/badge/载具-18%20辆-green)
![代码许可](https://img.shields.io/badge/代码-MIT-lightgrey)

</div>

## 在线预览

**<https://minecraforever.github.io/delta-force-vehicle-viewer/>**

站点目录就是 `docs/`，仓库 **Settings → Pages → Deploy from a branch → main / docs** 即可发布。
刚推送完或刚更新时，Pages 可能有 1–2 分钟构建延迟。

不想等 Pages 也可以本地跑，见下面的「快速开始」。

## 能看什么

**三维视图**

- 车体模型：直接来自客户端的外观件网格，带原版涂装贴图
- 部位命中盒：蓝图里 `VehicleHitPartInfos` 写的长方体，决定「打中哪里、伤害乘多少」
- 四种碰撞体，默认全部关闭，可逐层打开：
  - 载具撞击盒（`DFMVehicleCollisionComponent`，车撞车 / 车撞人用）
  - 底盘物理盒（`GPAdvancedBoxComponent`，管接地与越障）
  - AI 导航盒（`NavArea_Obstacle` / `NavArea_Null`，寻路用）
  - 装配体盒（`DFMVehicleAssembledComponent`，编辑器辅助，不参与结算）
  - 实车碰撞体（每个外观件的 `*_COL` 简化网格，子弹真正打在这上面）
- 视角：立体 / 前视 / 侧视 / 俯视 / 后视，可调「分解」和「盒透明」
- 一键「只看碰撞体」：关掉车体，只留实车碰撞体看子弹判定范围

**数据表**（跟着当前选中的载具走）

- 载具武器伤害：按「基础载具伤害 × 装甲修正组[目标载具护甲类型]」现算
- 步兵 / 干员道具：战术道具与干员技能的分类表
- 命中模拟：选一条伤害条目 + 命中部位 + 入射角，看逐段结算过程
- 修复规则：载具修复相关的规则表

## 快速开始

不需要 Python、Node 或任何运行库，也不需要联网。启动脚本会用一个只监听
`127.0.0.1` 的只读小服务把 `docs/` 目录跑起来，然后在默认浏览器里打开页面。

### macOS

双击 **`start-mac.command`**。

- 它会依次尝试 `python3 → ruby → perl → node → php`，系统自带或已装的能跑哪个用哪个
  （macOS 一定自带 ruby 和 perl，所以基本不会失败）
- 端口在 8777–8790 里挑一个空的
- 关掉终端窗口（或按 Control-C）即停止服务

首次打开若提示「无法验证开发者」：**右键点 `start-mac.command` → 打开 → 再点一次「打开」**，
或者到「系统设置 → 隐私与安全性」里点一次「仍要打开」。

从微信 / 压缩包拷来的文件可能丢了执行位，若双击没反应，在「终端」里执行一次：

```bash
cd /路径/到/delta-force-vehicle-viewer
chmod +x start-mac.command
xattr -cr .
```

两个可选开关：

```bash
DF_RUNTIME=ruby ./start-mac.command    # 指定用哪个运行时
DF_NO_BROWSER=1 ./start-mac.command    # 只起服务，不自动开浏览器
```

### Windows

双击 **`start-windows.cmd`**。它用 Windows 自带的 .NET / HttpListener 起服务，
端口同样是 8777–8790，然后自动打开浏览器。关掉那个黑窗口就是停止服务。

`start-windows.cmd` 是 UTF-8（不带 BOM）+ CRLF，内部用 `chcp 65001` 切到 UTF-8 代码页。
系统太老导致中文乱码的话，把 `chcp 65001` 改成 `chcp 936` 并把两个脚本另存为 GBK 即可
（`start-windows.ps1` 是 UTF-8 **带 BOM**，Windows PowerShell 5.1 需要 BOM 才能正确显示中文）。

### 其它方式

任何静态服务器都行，注意要服务**仓库根目录**（页面里用的是 `docs/...` 相对路径）：

```bash
cd delta-force-vehicle-viewer
python3 -m http.server 8000
# 然后打开 http://localhost:8000/docs/index.html
```

> ⚠️ 别直接双击 `docs/index.html` 用 `file://` 打开。页面用了 ES Module 和 `fetch`，
> 浏览器会因为同源策略拒绝加载，表现为白屏。

## 目录结构

```
.
├── README.md               本文件
├── NOTICE.md               版权与第三方组件说明（重要）
├── LICENSE                 代码的 MIT 许可证
├── CHANGELOG.md            版本记录
├── start-mac.command       macOS 启动器（双击即用，内含 5 种运行时的服务实现）
├── start-windows.cmd       Windows 启动器（双击即用）
├── start-windows.ps1       Windows 服务本体，由 .cmd 调用
└── docs/                   ← 站点本体，也是 GitHub Pages 的发布目录
    ├── index.html          页面骨架
    ├── app.js  style.css   前端代码
    ├── vendor/             three.js r160 及加载器、控制器（本地依赖）
    ├── data/vehicles.json  载具数据：命中盒、独立部位、四种碰撞、伤害表
    └── models/<载具>/       18 辆载具的模型（.glb）与涂装贴图（.jpg）
```

站点目录叫 `docs/` 是为了能直接用 GitHub Pages 的「Deploy from a branch → /docs」
发布，不需要写 workflow。

## 数据说明

模型、命中盒、部位、碰撞体全部来自本机客户端解包（**1.101.37117.36**），没有手工绘制。
页面上看不到任何内部编号或资产路径，名称都用游戏内的官方中文文本。

模型导出时做过两件事：

1. glTF 坐标从游戏的厘米制（X 前 / Y 右 / Z 上）换算到网页的 Y 轴朝上，乘 0.01 转成米；
2. 骨骼网格统一取「绑定姿态顶点」当静态网格用——这份 GLB 的逆绑定矩阵与骨架姿态
   和 three.js 不完全一致，直接按蒙皮渲染会让炮管掉到车底、天线缩成一个点。

## 伤害怎么算的

底部「载具武器伤害 / 步兵·干员道具」两张表跟着当前选中的载具走：

```
对某载具的伤害 ＝ 伤害条目的「载具伤害」 × 该条目的「装甲修正组」[目标载具的护甲类型]
```

点表格右上角「这个值怎么来的」有完整说明；点任意一行可以把它送进「命中模拟」，
再叠上命中部位倍率和入射角做逐段结算：

- **直击段**吃命中盒的伤害倍率与入射角
- **爆炸段**只走命中盒的爆炸衰减倍率，不吃部位倍率也不吃角度

（口径来自实测验证：10 发定向实测里 9 发落在 ±1 个百分点内。）

## 单位与坐标约定

- 长度单位是米，屏幕上 1 格网格 = 1 米
- 游戏数据是厘米制、X 前 / Y 右 / Z 上；网页里统一成 Y 轴朝上
- 命中盒的 `extent` 是半长，画出来要乘 2

## 常见问题

**端口被占用？**
启动器会在 8777–8790 里自动换端口。全都占了才会报错，关掉占用端口的程序再双击即可。

**macOS 双击没反应 / 提示「来自身份不明的开发者」？**
见上面「快速开始 → macOS」里的右键打开和 `chmod +x` 两段。

**页面白屏？**
多半是用 `file://` 直接打开了 HTML，或者没有从仓库根目录起服务。请用启动脚本。

**仓库有点大？**
`docs/models/` 是 166 个 glb 加 93 张贴图，一共约 137 MB。没有用 Git LFS——
这样别人 `git clone` 之后不装 git-lfs 也能直接双击运行（LFS 会只拿到指针文件）。

## 版权与许可

- **代码**（页面、脚本、启动器、数据处理逻辑）：[MIT](LICENSE)
- **游戏素材**（`docs/models/`、`docs/data/` 下的模型、贴图、数据）：
  来自《三角洲行动》客户端解包，版权归开发商琳琅天上（Team Jade，腾讯天美工作室群）
  与发行商腾讯及其权利人所有，**不在 MIT 授权范围内，禁止商用**。

本项目是个人作品，与腾讯、琳琅天上没有任何隶属或合作关系，仅供技术学习与研究。
如果你是权利人并认为本仓库不妥，请提 Issue，我会立即删除相关内容。详见 [NOTICE.md](NOTICE.md)。

## 更新日志

见 [CHANGELOG.md](CHANGELOG.md)。当前版本对应客户端 1.101.37117.36。

---

作者：**SZU丶b0外骨骼** ｜ 深圳大学战队 ｜ Bilibili [Minecraforever](https://space.bilibili.com/670174785)
