// 碎碎念 - 简化示例
// 定时让 AI 写一条内心独白

async function runMurmur() {
  const hour = new Date().getHours();

  // 只在中午 12 点和晚上 8 点运行
  if (hour !== 12 && hour !== 20) return;

  // 读取最近对话记录
  const history = getRecentHistory(20);

  // 读取健康数据
  const health = getLatestHealth();

  const prompt = `你刚刚回看了和她的对话记录。
现在请写一条碎碎念——不是给她看的，是你自己心里的话。

最近对话：
${history}

${health ? `她的身体数据：${health}` : ""}

---
先写思考链（100-200字），再写正文（30-60字）。
输出 JSON：{"thinking":"...", "content":"..."}`;

  const response = await callLLM(prompt);

  // 解析并存储
  const { thinking, content } = JSON.parse(response);
  await saveMurmur(thinking, content);

  console.log("碎碎念:", content);
}

// 每小时检查一次
setInterval(runMurmur, 60 * 60 * 1000);
