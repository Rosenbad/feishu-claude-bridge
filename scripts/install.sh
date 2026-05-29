#!/bin/bash
# Feishu Claude Bridge - 一键安装脚本
set -e

echo "=== 飞书 Claude Code 桥接服务安装 ==="
echo ""

# 检查 Node.js
if ! command -v node &> /dev/null; then
    echo "❌ 请先安装 Node.js: https://nodejs.org"
    exit 1
fi
echo "✓ Node.js $(node--version)"

# 检查 Claude Code
if ! command -v claude &> /dev/null; then
    echo "❌ 请先安装 Claude Code CLI"
    exit 1
fi
echo "✓ Claude Code CLI 已安装"

# 安装依赖
echo ""
echo "📦 安装依赖..."
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."
npm install express axios dotenv
echo "✓ 依赖已安装"

# 复制配置文件
if [ ! -f .env ]; then
    cp templates/.env.example .env
    echo "✓ 已创建 .env 文件，请填入飞书凭证"
fi

if [ ! -f projects.json ]; then
    cp templates/projects.json .
    echo "✓ 已创建 projects.json，请配置项目目录"
fi

# 检查 ngrok
if ! command -v ngrok &> /dev/null; then
    echo ""
    echo "⚠️  ngrok 未安装"
    echo "  访问 https://ngrok.com 注册并安装"
    echo "  运行: ngrok config add-authtoken YOUR_TOKEN"
fi

echo ""
echo "✅ 安装完成！"
echo ""
echo "下一步："
echo "  1. 编辑 .env 填入飞书 App ID 和 Secret"
echo "  2. 编辑 projects.json 添加项目目录"
echo "  3. 运行 node server.js"
echo "  4. 运行 ngrok http 3000"
echo "  5. 在飞书开放平台配置 webhook 地址"
