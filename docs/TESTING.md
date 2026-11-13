# 自动化测试

## 测试层级

| 层级 | 工具 | 覆盖范围 |
|---|---|---|
| 前端逻辑 | Node test + tsx | Composition/Scene DSL 校验、Canvas 与 GSAP 确定性 |
| 组件 | Vitest + Testing Library + jsdom | 受控控件、Modal 键盘与焦点、进度可访问性、新建项目流程 |
| Rust | cargo test | 存储、迁移、Agent、Provider、Canvas/GSAP 归一化、日志脱敏、轮转、Job Object 进程树 |
| 桌面 E2E | tauri-driver + WebDriverIO + msedgedriver | 真实 Tauri release 应用、页面导航、Canvas 操作与重启持久化 |

## 组件测试

```bash
npm run test:components
```

测试 DOM 环境在 `tests/components/setup.ts` 中提供 Testing Library cleanup、matchMedia、ResizeObserver 和 Canvas 2D mock。组件测试不连接真实 Provider，也不写用户项目目录。

## 桌面 E2E

```bash
npm run test:e2e:desktop:full
```

完整命令执行：

1. 构建前端、离线渲染运行目录和 Tauri release EXE。
2. 读取本机 Edge `ProductVersion`。
3. 使用匹配版本的 `msedgedriver`，缓存于 `node_modules/.cache`。
4. 启动 `tauri-driver`。
5. 在临时 `KNOWMOTION_E2E_DATA_DIR` 中运行测试。
6. 删除 WebDriver 会话并重新启动应用，验证 SQLite 项目恢复。

已有最新 release EXE 时，可直接运行：

```bash
npm run test:e2e:desktop
```

自定义路径：

```powershell
$env:KNOWMOTION_E2E_APP_EXE = "D:\builds\knowmotion-ai-studio.exe"
$env:KNOWMOTION_TAURI_DRIVER = "C:\Users\me\.cargo\bin\tauri-driver.exe"
$env:KNOWMOTION_EDGE_BINARY = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
npm run test:e2e:desktop
```

失败时 `e2e-artifacts/desktop-e2e-failure.png` 和 `.html` 会保留页面现场；每次运行会先清理上次诊断文件。

## CI

`.github/workflows/test.yml` 在 Windows runner 上安装 Node 24、Rust、npm 依赖和 `tauri-driver`，随后依次运行 Rust 测试、前端与组件测试、Lint 和完整桌面 E2E。失败时上传 E2E 截图和 DOM。
