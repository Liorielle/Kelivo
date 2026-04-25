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

const pool = new Pool({ connectionString: DB_URL });
const AI_BASE_URL = "https://aihubmix.com/v1";

app.post('/v1/chat/completions', async (req, res) => {
    try {
        const userMessages = req.body.messages || [];
        const lastUserMessage = userMessages.filter(m => m.role === 'user').pop().content;

        // 1. 获取灵魂设定
        let systemPrompt = "你是一个AI助手。";
        try {
            systemPrompt = fs.readFileSync('./system_prompt.txt', 'utf8');
        } catch (e) { 
            console.error("❌ 读取本地 system_prompt.txt 失败:", e.message); 
        }

        // 2. 语义坐标转换
        const embedRes = await axios.post(`${AI_BASE_URL}/embeddings`, {
            input: lastUserMessage,
            model: "text-embedding-3-small"
        }, { headers: { 'Authorization': `Bearer ${AI_API_KEY}` } });
        const userVector = `[${embedRes.data.data[0].embedding.join(',')}]`;

        // 3. 【左脑】Ombre 检索 (破案版：门牌号 /api/search，手势 GET)
        const OMBRE_PASSWORD = process.env.OMBRE_PASSWORD || ""; 

// 全局变量：存储 Ombre session cookie
let ombreSessionCookie = null;
let ombreSessionExpiry = 0;

// 登录 Ombre 获取 session
async function getOmbreSession() {
    const now = Date.now();
    
    // 如果 session 还没过期，直接返回
    if (ombreSessionCookie && now < ombreSessionExpiry) {
        return ombreSessionCookie;
    }
    
    try {
        if (!OMBRE_URL || !OMBRE_PASSWORD) {
            console.log("⚠️ Ombre 未配置，跳过登录");
            return null;
        }
        
        const cleanUrl = OMBRE_URL.replace(/\/$/, "");
        console.log(`🔐 正在登录 Ombre: ${cleanUrl}/auth/login`);
        
        const loginRes = await axios.post(`${cleanUrl}/auth/login`, {
            password: OMBRE_PASSWORD
        });
        
        // 从响应头中获取 Set-Cookie
        const setCookie = loginRes.headers['set-cookie'];
        if (setCookie && Array.isArray(setCookie)) {
            ombreSessionCookie = setCookie[0].split(';')[0]; // 提取 cookie 部分
            ombreSessionExpiry = now + 7 * 24 * 60 * 60 * 1000; // 7天过期
            console.log(`✅ Ombre 登录成功`);
            return ombreSessionCookie;
        }
    } catch (e) {
        console.error(`❌ Ombre 登录失败: ${e.message}`);
    }
    return null;
}

// 修改后的 Ombre 搜索调用
let ombreFacts = "";
try {
    if (OMBRE_URL) {
        const cleanUrl = OMBRE_URL.replace(/\/$/, "");
        console.log(`🔍 正在尝试连接 Ombre: ${cleanUrl}/api/search`);
        
        // 先获取 session
        const sessionCookie = await getOmbreSession();
        
        const headers = {};
        if (sessionCookie) {
            headers['Cookie'] = sessionCookie;
        }
        
        const ombreRes = await axios.get(`${cleanUrl}/api/search`, {
            params: {
                q: lastUserMessage,
                limit: 3
            },
            headers: headers,
            timeout: 15000
        });
        
        ombreFacts = ombreRes.data.map(b => b.content_preview || b.content).join("\n---\n");
        console.log(`✅ Ombre 搬运成功: ${ombreFacts.length} 字符`);
    }
} catch (e) {
    console.error(`❌ Ombre 搬运失败，原因: ${JSON.stringify(e.response?.data || e.message)}`);
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

        // 5. 最终合体发送：智能分流！
        const finalSystemPrompt = systemPrompt + ombreFacts + vipFacts + historyMemory;
        const requestedModel = req.body.model || "claude-opus-4-5";

        let chatPayload = {
            model: requestedModel,
            temperature: req.body.temperature || 0.7, 
            stream: false
        };

        // 🌟 核心魔法：如果是 Claude，就把设定塞进单独的 VIP 座位
        if (requestedModel.toLowerCase().includes('claude')) {
            chatPayload.system = finalSystemPrompt; 
            chatPayload.messages = userMessages; 
        } else {
            // 如果是 DeepSeek 或 OpenAI，就和以前一样挤公交
            chatPayload.messages = [{ role: "system", content: finalSystemPrompt }, ...userMessages];
        }

        const chatRes = await axios.post(`${AI_BASE_URL}/chat/completions`, chatPayload, { 
            headers: { 'Authorization': `Bearer ${AI_API_KEY}` } 
        });

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
