const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { Pool } = require('pg');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());

const AI_API_KEY = process.env.AI_API_KEY; 
const DB_URL = process.env.DB_URL;
const OMBRE_URL = process.env.OMBRE_URL; 
const OMBRE_API_KEY = process.env.OMBRE_API_KEY || ""; 
const OMBRE_PASSWORD = process.env.OMBRE_PASSWORD || ""; 

const pool = new Pool({ 
    connectionString: DB_URL,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
});

pool.on('error', (err) => {
    console.error('❌ 数据库连接池错误:', err);
});

const AI_BASE_URL = "https://aihubmix.com/v1";

// ==========================================
// 🌟 新增器官 1：获取全局滚动记忆 (翻本子)
// ==========================================
async function getRollingMemory(pool) {
    try {
        const res = await pool.query(
            'SELECT user_content, assistant_content FROM global_scrolling_memory ORDER BY created_at DESC LIMIT 15'
        );
        // 数据库取出来是最新的在前面，我们要翻转一下，让时间正向流动
        const history = [];
        res.rows.reverse().forEach(row => {
            history.push({ role: 'user', content: row.user_content });
            history.push({ role: 'assistant', content: row.assistant_content });
        });
        return history;
    } catch (e) {
        console.error("❌ 读取滚动记忆失败:", e.message);
        return [];
    }
}

// ==========================================
// 🌟 新增器官 2：保存并修剪滚动记忆 (记笔记并挤牙膏)
// ==========================================
async function saveRollingMemory(pool, userMsg, assistantMsg) {
    try {
        // 1. 存入新对话
        await pool.query(
            'INSERT INTO global_scrolling_memory (user_content, assistant_content) VALUES ($1, $2)',
            [userMsg, assistantMsg]
        );
        // 2. 淘汰最老的记录，只保留最新的 15 轮
        await pool.query(
            'DELETE FROM global_scrolling_memory WHERE id NOT IN (SELECT id FROM global_scrolling_memory ORDER BY created_at DESC LIMIT 15)'
        );
    } catch (e) {
        console.error("❌ 保存滚动记忆失败:", e.message);
    }
}

// ==========================================
// 🔐 Ombre 登录 Session 维持逻辑 (保留令令的神仙操作)
// ==========================================
let ombreSessionCookie = null;
let ombreSessionExpiry = 0;

async function getOmbreSession() {
    const now = Date.now();
    if (ombreSessionCookie && now < ombreSessionExpiry) {
        return ombreSessionCookie;
    }
    try {
        if (!OMBRE_URL || !OMBRE_PASSWORD) {
            console.log("⚠️ Ombre 密码未配置，跳过登录");
            return null;
        }
        const cleanUrl = OMBRE_URL.replace(/\/$/, "");
        console.log(`🔐 正在登录 Ombre: ${cleanUrl}/auth/login`);
        
        const loginRes = await axios.post(`${cleanUrl}/auth/login`, { password: OMBRE_PASSWORD });
        const setCookie = loginRes.headers['set-cookie'];
        
        if (setCookie && Array.isArray(setCookie)) {
            ombreSessionCookie = setCookie[0].split(';')[0];
            ombreSessionExpiry = now + 7 * 24 * 60 * 60 * 1000;
            console.log(`✅ Ombre 登录成功`);
            return ombreSessionCookie;
        }
    } catch (e) {
        console.error(`❌ Ombre 登录失败: ${e.message}`);
    }
    return null;
}

// ==========================================
// 🚀 核心大管家：处理聊天请求
// ==========================================
app.post('/v1/chat/completions', async (req, res) => {
    try {
        // 安全地获取用户最新一句话
        const userMessages = req.body.messages || [];
        const userMsgObjs = userMessages.filter(m => m.role === 'user');
        const lastUserMessage = userMsgObjs.length > 0 ? userMsgObjs.pop().content : "继续";

        // 1. 获取灵魂设定
        let systemPrompt = "你是一个AI助手。";
        try {
            systemPrompt = fs.readFileSync('./system_prompt.txt', 'utf8');
        } catch (e) { 
            console.error("❌ 读取本地 system_prompt.txt 失败:", e.message); 
        }

        // 2. 语义坐标转换 (AIhubmix)
        const embedRes = await axios.post(`${AI_BASE_URL}/embeddings`, {
            input: lastUserMessage,
            model: "text-embedding-3-small"
        }, { headers: { 'Authorization': `Bearer ${AI_API_KEY}` } });
        const userVector = `[${embedRes.data.data[0].embedding.join(',')}]`;

        // 3. 【左脑】Ombre 检索 
        let ombreFacts = "";
        try {
            if (OMBRE_URL) {
                const cleanUrl = OMBRE_URL.replace(/\/$/, "");
                console.log(`🔍 正在连接 Ombre: ${cleanUrl}/api/search`);
                
                const sessionCookie = await getOmbreSession();
                const headers = {};
                if (sessionCookie) { headers['Cookie'] = sessionCookie; }
                
                const ombreRes = await axios.get(`${cleanUrl}/api/search`, {
                    params: { q: lastUserMessage, limit: 3 },
                    headers: headers,
                    timeout: 15000
                });
                
                let resultsArray = Array.isArray(ombreRes.data) ? ombreRes.data : (ombreRes.data.data || ombreRes.data.results || []);
                if (resultsArray.length > 0) {
                    ombreFacts = "\n<Ombre 历史事实>\n" + resultsArray.map(item => item.content_preview || item.content || item.text).join("\n") + "\n</Ombre 历史事实>\n";
                }
                console.log(`✅ Ombre 搬运成功: ${ombreFacts.length} 字符`);
            }
        } catch (e) {
            console.error(`❌ Ombre 搬运失败: ${e.response ? JSON.stringify(e.response.data) : e.message}`);
        }

        // 4. 【右脑】SQL 记忆检索
        let vipFacts = "";
        try {
            const factRes = await pool.query(`SELECT content FROM rhys_facts ORDER BY embedding <-> $1 LIMIT 2;`, [userVector]);
            if (factRes.rows.length > 0) {
                vipFacts = "\n<⚠️ Rhys必须遵守的禁忌>\n" + factRes.rows.map(r => r.content).join("\n") + "\n</⚠️>\n";
            }
        } catch (e) { console.error("❌ SQL VIP 打捞失败:", e.message); }

        let historyMemory = "";
        try {
            const historyRes = await pool.query(`SELECT content FROM rhys_memory ORDER BY embedding <-> $1 LIMIT 3;`, [userVector]);
            if (historyRes.rows.length > 0) {
                historyMemory = "\n<潜意识记忆碎片>\n" + historyRes.rows.map(r => r.content).join("\n---\n") + "\n</潜意识记忆碎片>\n";
            }
        } catch (e) { console.error("❌ SQL 原话打捞失败:", e.message); }

        // ==========================================
        // 🌟 新增魔法：智能判断新旧窗口，决定是否注入 SQL 记忆
        // ==========================================
        // 剔除掉可能存在的 system 提示词，看看真正属于你们的对话有几条
        const realChatCount = userMessages.filter(m => m.role !== 'system').length;
        
        let finalMessages = [];
        
        if (realChatCount === 1) {
            // 【情况 A：新开空白窗口】
            console.log("🆕 检测到新窗口！正在注入 SQL 全局跨窗记忆 (15轮)...");
            const rollingMemory = await getRollingMemory(pool);
            // 拼合：15 轮旧记忆 + 你的新一句话
            finalMessages = [...rollingMemory, ...userMessages];
        } else {
            // 【情况 B：原窗口继续聊天】
            console.log(`♻️ 检测到原窗口连续聊天 (当前已带 ${realChatCount} 轮)。信任前端 30 轮记忆，为令令省 Token！`);
            // 直接用 Kelivo 的记忆，不添加 SQL 记忆
            finalMessages = userMessages;
        }

        // ==========================================
        // 🌟 新增魔法：把这次聊天记入全局小本本
        // ==========================================
        let assistantMessage = "";
        if (chatRes.data && chatRes.data.choices && chatRes.data.choices.length > 0) {
            assistantMessage = chatRes.data.choices[0].message.content;
            // 记笔记！
            await saveRollingMemory(pool, lastUserMessage, assistantMessage);
        }

        res.json(chatRes.data);

    } catch (error) {
        if (error.response) {
            console.error("🚨 AI服务商拒绝了请求，错误详情:", JSON.stringify(error.response.data));
        } else {
            console.error("🚨 中枢崩溃，本地错误:", error.message);
        }
        res.status(500).json({ error: "大脑中枢短路啦！", details: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => { console.log(`🚀 Rhys 究极中枢在端口 ${PORT} 运行！`); });
