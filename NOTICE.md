# 版权与第三方说明

## 1. 游戏素材（不在 MIT 范围内）

`docs/models/`、`docs/data/` 等目录下的三维模型、贴图与数据表，全部由本机安装的
《三角洲行动》（Delta Force）客户端解包导出：

- 开发：琳琅天上（Team Jade，腾讯天美工作室群）
- 发行：腾讯
- 版权归游戏开发商、发行商及其权利人所有

本仓库**不包含**游戏可执行文件、游戏代码或任何破解工具，只包含从本机客户端导出的
网格与贴图，用于技术学习、可视化研究与社区讨论。

- 本项目是个人作品，与腾讯、琳琅天上没有任何隶属或合作关系，非官方项目。
- 请勿将上述素材用于任何商业用途。
- 如果你是权利人并认为本仓库不妥，请提 Issue 或联系作者，我会立即删除相关内容。

## 2. 第三方开源组件

| 组件 | 版本 | 许可 | 说明 |
| --- | --- | --- | --- |
| [three.js](https://threejs.org/) | r160 | MIT | `docs/vendor/three.module.js` |
| three.js GLTFLoader | r160 | MIT | `docs/vendor/loaders/GLTFLoader.js` |
| three.js OrbitControls | r160 | MIT | `docs/vendor/controls/OrbitControls.js` |
| three.js BufferGeometryUtils | r160 | MIT | `docs/vendor/utils/BufferGeometryUtils.js` |

它们以本地文件形式随仓库分发（离线包不联网），许可证与上游一致，均为 MIT。

## 3. 本仓库代码

页面、脚本、启动器、数据处理逻辑等由作者编写，按 [MIT](LICENSE) 授权。
