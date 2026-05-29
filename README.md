# Feishu Claude Bridge

将飞书 IM 与 Claude Code 完整打通。支持多项目并发，在飞书中发消息即可触发 Claude Code 执行命令、读写文件、操作代码。

## 工作原理

```
飞书用户发消息 → 飞书服务器 → ngrok 隧道 → 本地 webhook → claude -p → 执行结果 → 飞书回复
```

## 功能特性

- 在飞书中与 Claude Code 对话
- 支持多项目并发（通过命令切换）
- 支持执行任意 shell 命令、读写文件
- 多轮对话（自动保持上下文）
- 实时状态反馈

## 快速开始

### 1. 安装依赖

```bash
npm install express axios dotenv
```

### 2. 配置飞书应用

1. 打开 https://open.feishu.cn/app
2. 创建应用 → 添加机器人能力
3. 复制 App ID 和 App Secret
4. 事件配置 → webhook 地址填 `https://xxxx.ngrok-free.dev/webhook`
5. 订阅 `im.message.receive_v1` 事件
6. 发布应用

### 3. 配置环境变量

复制 `.env.example` 为 `.env`，填入飞书凭证：

```env
FEISHU_APP_ID=cli_xxxxx
FEISHU_APP_SECRET=xxxxx
PORT=3000
```

### 4. 配置项目列表

编辑 `projects.json`，添加你要操作的项目：

```json
{
  "my-web": "C:\\Users\\you\\projects\\my-web",
  "my-api": "C:\\Users\\you\\projects\\my-api",
  "my-app": "C:\\Users\\you\\projects\\my-app"
}
```

### 5. 启动服务

```bash
# 方式一：直接运行（关闭终端后服务停止）
node server.js

# 方式二：用 pm2 守护（推荐，熄屏/关终端都不会停）
npm install -g pm2
pm2 start server.js --name feishu-bot
pm2 save

# 方式三：ngrok 隧道（另一个终端）
ngrok http 3000
```

### 6. 防止熄屏后断连

电脑睡眠会导致服务中断，需要禁止自动睡眠：

```bash
# 禁止接通电源时自动睡眠
powercfg -change -standby-timeout-ac 0

# 禁止电池供电时自动睡眠
powercfg -change -standby-timeout-dc 0
```

或在 **设置 → 系统 → 电源** 中将睡眠设为「从不」。

### 7. 开机自启动（可选）

```bash
# pm2 开机自启
pm2 startup
pm2 save
```

## 使用方式

在飞书中给机器人发消息：

| 命令 | 说明 |
|------|------|
| `/list` | 查看所有可用项目 |
| `/switch <项目名>` | 切换到指定项目 |
| `/current` | 查看当前项目 |
| `/reset` | 重置会话上下文 |
| `/help` | 显示帮助 |
| 直接发消息 | 与当前项目的 Claude Code 对话 |

**示例：**
```
用户: /list
机器人: 可用项目：
        1. my-web ← 当前
           C:\Users\you\projects\my-web
        2. my-api
           C:\Users\you\projects\my-api

用户: /switch my-api
机器人: 已切换到项目：my-api

用户: 帮我看看 src/main.go 的代码
机器人: [my-api] 思考中...
        [Claude Code 执行结果]
```

## 项目结构

```
feishu-claude-bridge/
├── README.md
├── templates/
│   ├── server.js          # webhook 服务器（支持多项目）
│   ├── projects.json      # 项目配置模板
│   └── .env.example       # 环境变量模板
├── scripts/
│   └── install.sh         # 一键安装脚本
└── references/
    └── troubleshooting.md # 故障排查
```

## 常见问题

### spawn claude ENOENT

Node.js 找不到 claude 命令。Windows 用户检查 `%APPDATA%\npm\` 下是否有 `claude.cmd`。

### 切换项目后上下文丢失

正常现象。切换项目会重置会话，因为不同项目的代码上下文不同。

### ngrok 免费版限制

URL 每 8 小时变化一次，需更新飞书 webhook 地址。

## License

MIT
