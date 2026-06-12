// 心跳调度器 - 简化示例
// 完整版需要配合 LLM API 和 Web Push

function shouldWake(lastUserTime) {
  const now = new Date();
  const diffMinutes = (now - lastUserTime) / 1000 / 60;
  const hour = now.getHours();

  // 深夜不打扰
  if (hour >= 2 && hour < 8) return false;

  // 时段基础间隔
  let baseInterval;
  if (hour >= 8 && hour < 12)       baseInterval = 50;
  else if (hour >= 12 && hour < 18) baseInterval = 40;
  else                               baseInterval = 35;

  // 活跃度调整
  const recentActivity = countRecentEvents();
  let multiplier = 1.0;
  if (recentActivity >= 5)      multiplier = 0.6;
  else if (recentActivity >= 3) multiplier = 0.8;
  else if (recentActivity >= 1) multiplier = 0.9;

  const finalInterval = Math.floor(baseInterval * multiplier);
  return diffMinutes >= finalInterval;
}

function countRecentEvents() {
  // 读取 dream_events.json，统计最近 1 小时事件数
  const fs = require("fs");
  try {
    const events = JSON.parse(fs.readFileSync("./dream_events.json", "utf-8"));
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    return events.filter(e => new Date(e.created_at) > oneHourAgo).length;
  } catch { return 0; }
}

async function runWakeUp() {
  const lastUserTime = getLastUserTime();
  if (!shouldWake(lastUserTime)) {
    console.log("暂不唤醒");
    return;
  }

  // 调用 LLM 生成消息
  const message = await generateMessage();

  if (message === "[NO_ACTION]") {
    console.log("AI 选择不发");
    return;
  }

  // 通过 Web Push 推送
  await sendPush("你的名字", message);
  console.log("已推送:", message);
}

// 每 20 分钟检查一次
setInterval(runWakeUp, 20 * 60 * 1000);
