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

        // 3. 【左脑】Ombre 检索
        let ombreFacts = "";
        try {
            if (OMBRE_URL) {
                const cleanUrl = OMBRE_URL.replace(/\/$/, ""); // 自动删掉末尾斜杠
                console.log(`🔍 正在尝试连接 Ombre: ${cleanUrl}/search`);
                const ombreRes = await axios.post(`${cleanUrl}/search`, {
                    text: lastUserMessage,
                    limit: 3
                }, { 
                    headers: { 'Authorization': `Bearer ${OMBRE_API_KEY}` },
                    timeout: 5000 // 5秒超时，防止拖慢整体速度
                });
                
                if (ombreRes.data && ombreRes.data.length > 0) {
                    ombreFacts = "\n<Ombre 历史事实>\n" + 
                                 ombreRes.data.map(item => item.content).join("\n") + 
                                 "\n</Ombre 历史事实>\n";
                }
            }
        } catch (e) { 
            // 🔧 关键改进：打印 Ombre 失败的具体原因
            console.error("❌ Ombre 搬运失败，原因:", e.response ? JSON.stringify(e.response.data) : e.message); 
        }

        // 4. 【右脑】SQL 记忆检索 (保持不变)
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

        // 5. 最终合体发送
        const finalSystemPrompt = systemPrompt + ombreFacts + vipFacts + historyMemory;
        const outMessages = [{ role: "system", content: finalSystemPrompt }, ...userMessages];

        const chatPayload = {
            model: req.body.model || "claude-3-5-sonnet-20240620",
            messages: outMessages,
            temperature: req.body.temperature || 0.7, 
            stream: false
        };

        const chatRes = await axios.post(`${AI_BASE_URL}/chat/completions`, chatPayload, { 
            headers: { 'Authorization': `Bearer ${AI_API_KEY}` } 
        });

        res.json(chatRes.data);

    } catch (error) {
        // 🔧 终极诊断：如果 AI 服务商报错，把对方的原话打印出来
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
