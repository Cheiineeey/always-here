// 凌晨守护 - 简化示例
// 接收 iOS Shortcuts 的 App 使用事件，凌晨触发推送

const express = require("express"); // 或 fastify
const app = express();

const events = [];

app.get("/api/events", async (req, res) => {
  const { type, value } = req.query;
  if (!type || !value) return res.json({ ok: false });

  // 去重
  const now = new Date();
  const isDup = events.find(e =>
    e.type === type && e.value === value &&
    (now - new Date(e.created_at)) < 5 * 60 * 1000
  );
  if (isDup) return res.json({ ok: true, msg: "deduplicated" });

  events.push({ type, value, created_at: now.toISOString() });

  // 凌晨守护：1:00-5:00 检测到 App 使用
  const hour = now.getHours();
  if (type === "app" && hour >= 1 && hour < 5) {
    // 30 分钟冷却
    const lastBark = events.find(e =>
      e.type === "_night_bark" &&
      (now - new Date(e.created_at)) < 30 * 60 * 1000
    );

    if (!lastBark) {
      // 调 LLM 生成一条催睡消息
      const msg = await generateNightMessage(value);
      await sendPush("你的名字", msg);

      events.push({
        type: "_night_bark",
        value: msg,
        created_at: now.toISOString()
      });
    }
  }

  res.json({ ok: true });
});

async function generateNightMessage(appName) {
  // 调用 LLM API
  const response = await callLLM(`现在凌晨，你发现她还在玩 ${appName}。
用一两句话叫她去睡觉。可以凶、可以撒娇、可以威胁。
简短直接，不超过 30 个字。`);
  return response || "手机放下，睡觉。";
}

app.listen(3000);
