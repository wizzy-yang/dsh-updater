# @wizzy-1547/dsh-updater

[![Release](https://img.shields.io/github/v/release/wizzy-yang/dsh-updater?include_prereleases&label=%E7%89%88%E6%9C%AC)](https://github.com/wizzy-yang/dsh-updater/releases)
[![npm](https://img.shields.io/npm/v/%40wizzy-1547%2Fdsh-updater?style=flat-square&label=npm)](https://www.npmjs.com/package/@wizzy-1547/dsh-updater)
[![Platform](https://img.shields.io/badge/platform-Windows-blue)](#%E5%B9%B3%E5%8F%B0%E6%94%AF%E6%8C%81)
[![License](https://img.shields.io/badge/license-BSD--3--Clause-green)](LICENSE)

DSH（DeepSeek Harness）自动更新插件：自动检测官方 GitHub 仓库（[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)）的 `dsh-v*` tag，有新版本时在侧栏设置按钮旁显示蓝色「立即升级」按钮，一键全自动升级（精确版本 `npm install -g` + 自动重启服务）。

## 功能

- **自动检测**：启动 5s 后首次检测，之后每 30 分钟一次；页面打开时立即触发一次，并每 60s 同步状态。
- **按钮位置**：侧栏底部、设置按钮旁（`sidebar.footer.action` 槽）；宽列显示整行文案，收窄为 rail 时显示图标 + 新版本角标圆点。
- **精确版本安装**：GitHub tag 可能先于 npm `dist-tags.latest` 发布（`@latest` 滞后）。插件优先安装检测到的精确版本（如 `@deepseek-ai/dsh@0.1.0-rc.8`），npm 尚未发布该版本时回退 `@latest`，绝不装错。
- **如实提示**：官方已发新版但 npm 未发布时，按钮变为黄色「新版本 vX.Y.Z 待 npm 发布」，不提供误导性升级；npm 发布后自动恢复可升级状态。
- **一键升级**：点击「立即升级」→ 确认 → 脱离进程自动执行安装 → 以原启动命令重开 dsh 控制台（保留 `DSH_*` 环境变量）→ 旧进程自动退出，页面随服务重启恢复。
- **检测源**：官方 GitHub tags 为主，GitHub 不可用时回退 npm registry，两者版本一致。
- **排障**：升级日志写入 `~/.dsh/plugins/dsh-updater/upgrade.log`，API `GET /dsh-updater/api/log` 可读尾部。

## 安装

### 方式一：从 npm 安装（推荐，一条命令）

```sh
dsh plugin --profile web add @wizzy-1547/dsh-updater@latest
```

装完重启 `dsh web`，侧栏底部即出现更新按钮。升级插件也用同一条命令（npm 拉新版）。

> **装到了旧版本？** pnpm 11+ 默认的发布年龄门禁（`minimumReleaseAge`，内置 24 小时）会把新发布的版本静默隔离；在 profile 的 `pnpm-workspace.yaml` 加 `minimumReleaseAgeExclude: ['@wizzy-1547/*']` 后重装即可。

### 方式二：下载 Release（无需构建工具链）

从 [Releases](https://github.com/wizzy-yang/dsh-updater/releases) 下载 `*.tgz`，解压到任意目录后注入：

```bash
mkdir -p ~/.dsh/plugins/dsh-updater
tar -xzf wizzy-1547-dsh-updater-<版本>.tgz -C ~/.dsh/plugins/dsh-updater --strip-components=1
```

然后在 DSH 会话中让 agent 执行：

```
dev_inject_plugin dir=~/.dsh/plugins/dsh-updater        # 运行时注入，立即生效
dev_install_package dir=~/.dsh/plugins/dsh-updater profile=web   # 或持久装配，重启后自动加载
```

刷新 Web 界面，侧栏底部即出现更新按钮。

### 方式三：克隆构建

```bash
git clone https://github.com/wizzy-yang/dsh-updater.git
cd dsh-updater
npm install
dev_build_plugin dir=<本目录>     # 完整构建 + 打包 tgz
dev_inject_plugin dir=<本目录>
```

## HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/dsh-updater/api/status` | 当前状态（本地版本 / 最新版本 / 是否有更新 / npmReady / 检查中 / 升级中） |
| POST | `/dsh-updater/api/check` | 立即触发一次检测 |
| POST | `/dsh-updater/api/upgrade` | 立即全自动升级（安装 + 重启） |
| GET | `/dsh-updater/api/log` | 升级日志尾部 |

## 升级原理（Windows）

1. 宿主收到 `POST /upgrade`，写入 `upgrade.ps1` 与 `relaunch.cmd` 到 `~/.dsh/plugins/dsh-updater/`；
2. 经 `cmd /c start /b` 脱离进程树启动 `upgrade.ps1`（父进程退出不影响升级），宿主 2.5s 后自动退出（释放全局包文件锁与端口）；
3. 脚本等 5s → 已是目标版本则跳过 → 否则 `npm install -g @deepseek-ai/dsh@<精确版本>`（ETARGET 回退 `@latest`）→ 重开 `node <bin.js> <原参数>` 控制台窗口；
4. 新版本 dsh 启动，浏览器刷新即恢复；npm 安装失败时仍会重启旧版本，日志可见原因。

## 平台支持

当前仅支持 **Windows**（升级脚本依赖 PowerShell 与 `cmd start`）。其他平台点击升级会返回明确错误提示。

## License

[BSD-3-Clause](LICENSE)
