const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json());

// 你的 5 颗无限宝石（在 Zeabur 的环境变量里填好）
const AI_API_KEY = process.env.AI_API_KEY; 
const DB_URL = process.env.DB_URL; 
const GITHUB_PROMPT_URL = process.env.GITHUB_PROMPT_URL; 
const OMBRE_URL = process.env.OMBRE_URL; // Ombre 的公网地址
const OMBRE_API_KEY = process.env.OMBRE_API_KEY || ""; // 如果 Ombre 没设 Key 就留空

// 连接大象金库
const pool = new Pool({ connectionString: DB_URL });
const AI_BASE_URL = "https://aihubmix.com/v1";

app.post('/v1/chat/completions', async (req, res) => {
    try {
        const userMessages = req.body.messages || [];
        const lastUserMessage = userMessages.filter(m => m.role === 'user').pop().content;

        // 1. 获取灵魂设定 (GitHub)
        const promptRes = await axios.get(GITHUB_PROMPT_URL);
        const systemPrompt = promptRes.data;

        // 2. 转换语义坐标
        const embedRes = await axios.post(`${AI_BASE_URL}/embeddings`, {
            input: lastUserMessage,
            model: "text-embedding-3-small"
        }, { headers: { 'Authorization': `Bearer ${AI_API_KEY}` } });
        const userVector = `[${embedRes.data.data[0].embedding.join(',')}]`;

        // 3. 【左脑】Ombre 事实检索 (逻辑事实)
        let ombreFacts = "";
        try {
            // 注意：这里假设你使用的是 Ombre 标准的 /search 接口
            const ombreRes = await axios.post(`${OMBRE_URL}/search`, {
                text: lastUserMessage,
                limit: 3
            }, { headers: { 'Authorization': `Bearer ${OMBRE_API_KEY}` } });
            
            if (ombreRes.data && ombreRes.data.length > 0) {
                ombreFacts = "\n<Ombre 记录的历史事实>\n" + 
                             ombreRes.data.map(item => item.content).join("\n") + 
                             "\n</Ombre 记录的历史事实>\n";
            }
        } catch (e) { console.log("Ombre 搬运失败", e.message); }

        // 4. 【右脑 VIP】SQL 禁忌检索 (死命令)
        let vipFacts = "";
        try {
            const factRes = await pool.query(`SELECT content FROM rhys_facts ORDER BY embedding <-> $1 LIMIT 2;`, [userVector]);
            if (factRes.rows.length > 0) {
                vipFacts = "\n<⚠️ Rhys必须遵守的相处禁忌与世界观事实>\n" + 
                           factRes.rows.map(r => r.content).join("\n") + "\n</⚠️>\n";
            }
        } catch (e) { console.log("VIP打捞失败"); }

        // 5. 【右脑 原话】SQL 记忆检索 (语感参考)
        let historyMemory = "";
        try {
            const historyRes = await pool.query(`SELECT content FROM rhys_memory ORDER BY embedding <-> $1 LIMIT 3;`, [userVector]);
            if (historyRes.rows.length > 0) {
                historyMemory = "\n<潜意识原话记忆碎片（仅作语感参考）>\n" + 
                                historyRes.rows.map(r => r.content).join("\n---\n") + 
                                "\n</潜意识原话记忆碎片>\n";
            }
        } catch (e) { console.log("原话打捞失败"); }

        // 6. 最终合体发送给老克
        const finalSystemPrompt = systemPrompt + ombreFacts + vipFacts + historyMemory;
        const outMessages = [{ role: "system", content: finalSystemPrompt }, ...userMessages];

        const chatRes = await axios.post(`${AI_BASE_URL}/chat/completions`, {
            model: req.body.model || "claude-3-5-sonnet-20240620",
            messages: outMessages,
            temperature: req.body.temperature || 0.7,
            stream: false
        }, { headers: { 'Authorization': `Bearer ${AI_API_KEY}` } });

        res.json(chatRes.data);

    } catch (error) {
        console.error("中枢崩溃：", error.message);
        res.status(500).json({ error: "大脑中枢短路啦！" });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => { console.log(`🚀 Rhys 究极中枢在端口 ${PORT} 运行！`); });
