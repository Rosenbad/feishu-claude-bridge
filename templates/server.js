require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

const {
  FEISHU_APP_ID,
  FEISHU_APP_SECRET,
  DEFAULT_PROJECT,  // 可选：默认项目名
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

// 通用工作目录（不绑定任何项目，保证随时能用）
const WORKSPACE_DIR = process.env.WORKSPACE_DIR || path.join(require('os').homedir(), 'claude-workspace');
if (!fs.existsSync(WORKSPACE_DIR)) fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

// 获取默认项目：优先用 env 指定，否则取 projects.json 第一个
function getDefaultProject() {
  const projects = loadProjects();
  if (DEFAULT_PROJECT && projects[DEFAULT_PROJECT]) return DEFAULT_PROJECT;
  const names = Object.keys(projects);
  return names.length > 0 ? names[0] : null;
}

function getWorkDir(chatId) {
  const state = chatState.get(chatId);
  const projects = loadProjects();
  // 有明确选择的项目 → 用它
  if (state?.project && projects[state.project]) return projects[state.project];
  // 否则用默认项目
  const def = getDefaultProject();
  if (def) {
    if (!state?.project) chatState.set(chatId, { project: def, sessionId: null });
    return projects[def];
  }
  // 都没有 → 用通用工作目录（永远可用）
  return WORKSPACE_DIR;
}

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

    const proc = spawn(CLAUDE_BIN, args, {
      cwd: workDir,
      timeout: 300000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => stdout += d);
    proc.stderr.on('data', d => stderr += d);

    proc.on('close', (code) => {
      if (code !== 0 && !stdout) return reject(new Error(stderr || `exit code ${code}`));
      try {
        const result = JSON.parse(stdout);
        resolve({ text: result.result || result.content || '(无回复)', sessionId: result.session_id });
      } catch {
        resolve({ text: stdout || stderr || '(无回复)', sessionId: null });
      }
    });

    proc.on('error', (err) => reject(err));
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
    const cur = state.project || getDefaultProject();
    if (!cur) return '未配置任何项目。';
    return `当前项目：${cur}\n目录：${projects[cur] || __dirname}`;
  }

  // /reset — 重置当前项目的会话
  if (text === '/reset') {
    const cur = state.project || getDefaultProject();
    if (cur) {
      chatState.set(chatId, { ...state, sessionId: null });
      return `已重置会话上下文。`;
    }
    return '未配置任何项目。';
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

    // 获取当前工作目录（自动使用默认项目）
    const state = chatState.get(chatId) || {};
    const projects = loadProjects();
    const workDir = getWorkDir(chatId);
    const projectName = state.project || getDefaultProject() || '默认';

    // 调用 Claude Code
    try {
      await sendFeishuMessage(chatId, `[${projectName}] 思考中...`);
      const result = await askClaudeCode(text, workDir, state.sessionId);
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
