# 任务依赖图（多维表格扩展程序）

只读展示多维表格里的任务依赖关系与父子关系，用 AntV G6 绘制。

English: [README.md](README.md)

## 它做什么

- **视图切换** — 层级·上下（默认）/ 层级·左右 / 力导向 / 环形 / 辐射。
- **节点** — 标题、截止时间（逾期标红）、阻塞徽标（`阻塞：N`，N = 被它**传递阻塞**的下游未完成任务数）、**所属清单**（蓝色胶囊）+ 标签胶囊（最多 2 个 + `+N`）；左侧色条 红=未完成 / 灰绿=已完成。
- **依赖边** — **任务 → 前置**，箭头指向所等待的那件事。布局上**前置在上、任务在下**，锚点按两节点实际相对位置动态选取。三态着色：红=前置未完成（阻塞中）、绿=前置已完成（可推进）、灰=本任务已完成（关系已失效）。
- **父子边** — 父 → 子，灰色虚线，无箭头。**可在设置里关闭**；关掉后只有父子关系的任务不再出现在图里。
- **清单** — 可动手 / 被阻塞 / 已完成 / 全部，支持搜索清单与标签，点条目定位到图上节点。
- **详情** — 任务内容（描述正文）、可点击的前置/后继/父/子任务、可点击的清单与标签（点击即筛选）、网页链接与客户端链接。
- **交互** — 单击选中并高亮邻接、双击唤起滴答、右键折叠/展开、滚轮按物理距离缩放、`显示全部` 一键全览。
- **侧栏** — 可收起；窄屏（飞书侧边栏）下移到底部，收起时是一行横向入口，展开时占下半部分，不覆盖画布。

## 窄容器（飞书侧边栏）下的行为

| 画布宽度 | 节点尺寸 | 侧栏 |
|---|---|---|
| ≥ 560px | 常规（宽 132–240） | 常驻右侧，可收起 |
| < 560px | **紧凑**（宽 100–168，更小留白） | 移到底部，收起为一行入口 |

配合 `minZoom: 0.2`，大图可以一直缩到看见全貌；`显示全部` 也会按这个下限适配。缩到很低时文字不可读，但能看清整体结构，状态栏会显示「最小缩放」。

## 交付给别人使用

### 1. 注册插件应用（一次性）

1. 打开 [飞书开发者后台](https://open.feishu.cn/app)，创建**企业自建应用**。
2. 添加应用能力 → **多维表格插件** → 数据表视图。
3. 把分配的 `blockTypeID` 填进 `block.json`。

### 2. 配置字段

插件**不写死字段名**：打开后列出当前表的所有自关联字段，由你选择。

字段方向默认按「字段里存的是我的前置」处理。如果某张表的单向关联方向相反（字段存的是「我的后续」），
箭头会整体反掉；这种情况下把 `config` 语义调整为 `fieldIsSuccessor` 即可。

选择会**持久化**到飞书 Bridge（同一文档的同一插件共享），下次打开直接还原。

### 3. 部署（把页面地址填进飞书）

飞书扩展脚本的官方用法是**自己提供一个页面地址**：在多维表格里「新增脚本」粘贴 URL。
没有「上传后由飞书托管」的 CLI（`block-basekit-cli` 是自动化插件的工具，不适用）。

| 方式 | 命令 | 说明 |
|---|---|---|
| 本地调试 | `npm run dev` | 本地 HTTPS 服务，地址填进飞书；需与飞书所在网络可达 |
| 正式使用 | 见下方 GitHub Pages | 公开静态托管，地址稳定，证书由平台提供 |

**GitHub Pages 部署（当前采用）**

- 仓库：[silasliu/lark-base-relation-viz](https://github.com/silasliu/lark-base-relation-viz)（public）
- 访问地址：<https://blog.silas.fun/lark-base-relation-viz/>
- 源码在 `main` 分支，构建产物在 `gh-pages` 分支，Pages 从 `gh-pages` 发布
- 更新流程：改代码 → `npm run build` → 把 `dist` 内容推到 `gh-pages`

> `public/mock-data.json` 是从真实 Base 导出的快照，只在本地调试用。
> `vite.config.ts` 里 `build.copyPublicDir: false` 保证它**不会**进入构建产物，
> 因此公开部署的版本不含任何真实数据。

## 为什么「唤起客户端」可能没反应

飞书把扩展跑在 **sandboxed iframe** 里。按 HTML 规范，沙箱 iframe 里指向自定义协议（`ticktick://`）的导航会被**静默丢弃**，除非宿主授予 `allow-popups` 或 `allow-top-navigation-to-custom-protocols` —— 这两个 token 由飞书控制，插件改不了。

所以：

- **网页版链接**（`https://dida365.com/webapp/#p/...`）永远可用，是主路径。
- **唤起客户端**用真实的 `<a href="ticktick://...">` 尝试（比 `a.click()` 信任等级更高），若被拦则无反应 —— 这不是插件 bug。
- 兜底：**「复制标题」**，粘进滴答搜索框即可。

`@lark-base-open/js-sdk` 没有任何打开外部协议或外部链接的 API（已核对 1.0.2 全部导出）。

## 调试（浏览器直开）

在飞书宿主之外打开时，SDK 永不 resolve。插件会自动回退到 `public/mock-data.json`
（从真实 Base 导出的快照，已 gitignore），方便在浏览器里调布局和交互。

```bash
npm run dev          # http://localhost:5173
```

## 目录结构

```
feishu-plugins/dependency-graph/
├── src/
│   ├── config.ts                  # 附加字段名 + 滴答搜索 Scheme
│   ├── types.ts                   # 数据结构（含方向语义 BuildOptions）
│   ├── App.tsx                    # 工具栏 / 方向确认 / 侧栏 / 弹窗预告
│   ├── services/
│   │   ├── BaseDataService.ts     # SDK 读表（含 mock 回退）、单元格归一化
│   │   ├── ConfigStore.ts         # 配置持久化（表/字段/方向/布局）
│   │   └── graphBuilder.ts        # 纯逻辑：任务 → 图 + 清单分组（含方向翻转）
│   └── components/
│       ├── DependencyGraph.tsx    # G6 图：选中/双击/resize/缩放
│       ├── graphShapes.ts         # 节点/边形状、布局配置、重叠分离
│       ├── nodeMetrics.ts         # 节点内容与尺寸（宽度感知，与绘制同字号）
│       ├── ChecklistPanel.tsx     # 清单
│       └── DetailsPanel.tsx       # 详情
├── block.json                     # 插件清单（需填 blockTypeID）
├── public/mock-data.json          # 浏览器调试快照（gitignore）
└── vite.config.ts
```

## 构建与自检

```bash
npm run typecheck    # 类型检查
npm run build        # 产物在 dist/
```

## 关键实现说明

1. **节点尺寸必须传给 dagre**（`size: [w, h]`）。不传的话 dagre 按 40×40 排布，节点会大面积重叠——这是「标签互相覆盖」的真正原因，不是文字溢出。
2. **边的几何只由 `getPath` 决定**。G6 v4 在 item 更新时会用 `getPath` 重算路径，只在 `draw` 里写 path 会在重排后变形。
3. **控制点按布局主轴计算**：层级上下用垂直控制点，层级左右用水平控制点。混用会让斜边严重扭曲（实测偏离弦线 159px）。
4. **父子边必须 `return`**，否则会继续画第二条依赖边，叠加成「灰色虚线 + 红绿箭头」。
5. **resize 不重置缩放**，只有首次加载才适配整图，否则用户放大后的视野会被抹掉；适配使用本地 `fitGraph`，不会把低于 `minZoom` 的比例交给 G6。

## 已知限制

1. 只读，不能在图上改关系。
2. 仅支持自关联字段；跨表关联不出现在下拉框。
3. 滴答跳转靠搜索（官方没有按 taskId 直达的 scheme），重名任务可能要多点一次。
4. 非 HTTPS 来源唤起滴答**每次都会弹确认**（见上文），无法在前端消除。
5. 父子字段只取第一个值。
6. G6 v4；`radial`/`circular` 布局的重叠由后置分离算法兜底，节点极多时可能有少量残余。

## 参考

- [多维表格扩展脚本 API](https://lark-base-team.github.io/js-sdk-docs/zh/)
- [AntV G6 v4 文档](https://g6.antv.antgroup.com/)
- [滴答清单 URL Scheme](https://help.dida365.com/tasks/a/6424515668858634240)
