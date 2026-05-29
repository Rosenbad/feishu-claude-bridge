require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

const {
  FEISHU_APP_ID,
  FEISHU_APP_SECRET,
  PORT = 3000
} = process.env;

// ─── 项目配置 ───────────────────────────────────────────────
// 从 projects.json 加载项目列表
const PROJECTS_FILE = path.join(__dirname, 'projects.json');

function loadProjects() {
  try {
    return JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

// 每个 chat 的当前项目和会话 ID
const chatState = new Map(); // chatId -> { project, sessionId }

// Claude Code CLI 完整路径
const CLAUDE_BIN = process.platform === 'win32'
  ? `${process.env.APPDATA}\\npm\\claude.cmd`
  : 'claude';

// ─── 飞书 API ───────────────────────────────────────────────

let tenantToken = null;
let tokenExpiry = 0;

async function getTenantToken() {
  if (tenantToken && Date.now() < tokenExpiry) return tenantToken;
  const res = await axios.post(
    'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
    { app_id: FEISHU_APP_ID, app_secret: FEISHU_APP_SECRET }
  );
  tenantToken = res.data.tenant_access_token;
  tokenExpiry = Date.now() + (res.data.expire - 60) * 1000;
  return tenantToken;
}

async function sendFeishuMessage(chatId, text) {
  const token = await getTenantToken();
  await axios.post(
    'https://open.feishu.cn/open-apis/im/v1/messages',
    { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text }) },
    {
      params: { receive_id_type: 'chat_id' },
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
    }
  );
}

// ─── Claude Code CLI ─────────────────────────────────────────

function askClaudeCode(userMessage, workDir, sessionId) {
  return new Promise((resolve, reject) => {
    const args = ['-p', userMessage, '--output-format', 'json', '--dangerously-skip-permissions'];
    if (sessionId) args.push('--resume', sessionId);

    execFile(CLAUDE_BIN, args, {
      cwd: workDir,
      timeout: 300000,
      maxBuffer: 10 * 1024 * 1024,
      shell: true
    }, (error, stdout, stderr) => {
      if (error && !stdout) return reject(new Error(stderr || error.message));
      try {
        const result = JSON.parse(stdout);
        resolve({ text: result.result || result.content || '(无回复)', sessionId: result.session_id });
      } catch {
        resolve({ text: stdout || stderr || '(无回复)', sessionId: null });
      }
    });
  });
}

// ─── 命令处理 ───────────────────────────────────────────────

function handleCommand(text, chatId) {
  const state = chatState.get(chatId) || {};
  const projects = loadProjects();
  const projectNames = Object.keys(projects);

  // /list — 列出所有项目
  if (text === '/list') {
    if (projectNames.length === 0) return '暂无项目。请编辑 projects.json 添加。';
    const list = projectNames.map((name, i) => {
      const marker = state.project === name ? ' ← 当前' : '';
      return `${i + 1}. ${name}${marker}\n   ${projects[name]}`;
    }).join('\n');
    return `可用项目：\n${list}\n\n使用 /switch <项目名> 切换`;
  }

  // /switch <项目> — 切换项目
  if (text.startsWith('/switch')) {
    const name = text.replace('/switch', '').trim();
    if (!name) return '用法：/switch <项目名>';
    if (!projects[name]) return `项目 "${name}" 不存在。使用 /list 查看可用项目。`;
    chatState.set(chatId, { ...state, project: name, sessionId: null });
    return `已切换到项目：${name}\n目录：${projects[name]}`;
  }

  // /current — 显示当前项目
  if (text === '/current') {
    if (!state.project) return '当前未选择项目。使用 /list 查看可用项目。';
    return `当前项目：${state.project}\n目录：${projects[state.project]}`;
  }

  // /reset — 重置当前项目的会话
  if (text === '/reset') {
    if (state.project) {
      chatState.set(chatId, { ...state, sessionId: null });
      return `已重置项目 "${state.project}" 的会话上下文。`;
    }
    return '当前未选择项目。';
  }

  // /help — 帮助
  if (text === '/help') {
    return [
      '命令列表：',
      '/list     — 查看所有项目',
      '/switch <项目名> — 切换项目',
      '/current  — 查看当前项目',
      '/reset    — 重置会话上下文',
      '/help     — 显示帮助',
      '',
      '直接发消息即可与当前项目的 Claude Code 对话。'
    ].join('\n');
  }

  return null; // 不是命令
}

// ─── Webhook ─────────────────────────────────────────────────

app.post('/webhook', async (req, res) => {
  const { challenge, header, event } = req.body;

  if (challenge) return res.json({ challenge });
  if (req.body.type === 'url_verification') return res.json({ challenge: req.body.challenge });

  if (header?.event_type === 'im.message.receive_v1') {
    const message = event?.message;
    const sender = event?.sender;

    if (message?.message_type !== 'text') return res.json({ code: 0 });

    let text = '';
    try { text = JSON.parse(message.content).text || ''; }
    catch { return res.json({ code: 0 }); }

    if (sender?.sender_type === 'app') return res.json({ code: 0 });

    res.json({ code: 0 });

    const chatId = message.chat_id;

    // 处理命令
    const cmdResult = handleCommand(text.trim().toLowerCase(), chatId);
    if (cmdResult) {
      try { await sendFeishuMessage(chatId, cmdResult); } catch {}
      return;
    }

    // 检查是否已选择项目
    const state = chatState.get(chatId);
    const projects = loadProjects();
    if (!state?.project || !projects[state.project]) {
      try {
        await sendFeishuMessage(chatId,
          '请先选择项目：\n/list — 查看可用项目\n/use <项目名> — 切换项目');
      } catch {}
      return;
    }

    // 调用 Claude Code
    try {
      await sendFeishuMessage(chatId, `[${state.project}] 思考中...`);
      const result = await askClaudeCode(text, projects[state.project], state.sessionId);
      if (result.sessionId) {
        chatState.set(chatId, { ...state, sessionId: result.sessionId });
      }
      await sendFeishuMessage(chatId, result.text);
    } catch (err) {
      console.error('处理失败:', err.message);
      try { await sendFeishuMessage(chatId, `出错了: ${err.message}`); } catch {}
    }
    return;
  }

  res.json({ code: 0 });
});

app.get('/health', (req, res) => {
  const projects = loadProjects();
  res.json({ status: 'ok', mode: 'claude-code-cli', projects: Object.keys(projects) });
});

app.listen(PORT, () => {
  console.log(`飞书 Claude Code 机器人: http://localhost:${PORT}`);
  console.log(`Webhook: http://localhost:${PORT}/webhook`);
  const projects = loadProjects();
  console.log(`已配置 ${Object.keys(projects).length} 个项目`);
});
