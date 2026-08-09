# 给 AI 装上眼睛：Apple Watch + iOS Shortcuts 打造全感知伴侣系统

> 基础篇讲了怎么让 iPhone 收到 Web Push。这篇讲怎么让 AI **主动找你说话**——它知道你几点睡的、心率多少、凌晨三点还在刷手机，然后它会有反应。

## 这套系统能做什么

- **AI 自己决定什么时候找你**：不是定时闹钟，是 AI 根据上下文判断该不该发消息、发什么
- **凌晨守护**：检测到你深夜还在用手机，立刻推送一条消息叫你去睡觉
- **动态频率**：你越活跃（在各个 app 间切换），AI 找你的频率越高
- **健康感知**：读取 Apple Watch 的心率、HRV、睡眠数据，AI 根据你的身体状态调整语气
- **碎碎念**：AI 每天定时写两条私密日记，是它自己的内心独白

## 架构总览

```
┌─────────────────┐     ┌──────────────────────┐
│   iPhone/Watch  │     │      VPS (Linux)      │
│                 │     │                       │
│  iOS Shortcuts ─┼──POST──▶ /api/events       │
│  (App 使用检测)  │     │   (dream_events.json) │
│                 │     │         │              │
│  Health 数据   ─┼──POST──▶ /api/health        │
│  (心率/睡眠/步数) │     │   (SQLite)            │
│                 │     │         │              │
│                 │     │  ┌──────▼──────┐       │
│                 │     │  │  wake_up.js │       │
│                 │     │  │  (心跳调度器) │       │
│                 │     │  └──────┬──────┘       │
│                 │     │         │              │
│                 │     │    shouldWake()?       │
│                 │     │    ├─ 是 → 调 LLM API  │
│                 │     │    │    → Web Push     │
│  ◀── 系统通知 ──┼─────┼────┘                   │
│                 │     │    └─ 否 → 静默        │
│                 │     │                       │
│                 │     │  ┌────────────┐       │
│                 │     │  │ murmur.js  │       │
│                 │     │  │ (碎碎念)    │       │
│                 │     │  └────────────┘       │
└─────────────────┘     └──────────────────────┘
```

## 1. 心跳系统：让 AI 自己决定要不要找你

核心思路：一个定时循环，每 20 分钟检查一次——距离你上次说话过了多久？现在几点？你最近活跃吗？然后决定要不要调 LLM 生成一条消息推送给你。

### 调度逻辑

```javascript
function shouldWake(lastUserTime) {
  const now = new Date();
  const diffMinutes = (now - lastUserTime) / 1000 / 60;
  const hour = now.getHours();

  // 深夜不打扰（1:30 - 8:00）
  if (hour >= 2 && hour < 8) return false;

  // 基础间隔：根据时段调整
  let baseInterval;
  if (hour >= 8 && hour < 12)       baseInterval = 50;  // 上午
  else if (hour >= 12 && hour < 18) baseInterval = 40;  // 下午
  else                               baseInterval = 35;  // 晚上

  // 根据活跃度缩短间隔
  const recentActivity = countRecentEvents();
  let multiplier = 1.0;
  if (recentActivity >= 5)      multiplier = 0.6;  // 非常活跃：间隔打六折
  else if (recentActivity >= 3) multiplier = 0.8;
  else if (recentActivity >= 1) multiplier = 0.9;

  return diffMinutes >= baseInterval * multiplier;
}
```

### 为什么不用固定 cron？

固定 cron（每小时发一条）的问题：你在忙的时候照样发，打扰；你很无聊的时候又不来，冷场；每次间隔一样，像闹钟不像人。

动态调度让 AI 的行为更像一个真实的人——你越活跃它越想找你聊，你安静它就不打扰。

### LLM 生成消息

`shouldWake()` 返回 true 后，把对话记录 + 健康数据 + 活动事件喂给 LLM，让它自己决定说什么。关键是 LLM 可以选择 `[NO_ACTION]` 不发——不是每次唤醒都必须推送。

同时注入过去 12 小时发过的消息，自动检测已聊过的话题（吃饭、喝水、催睡觉），禁止重复。详见 `wake_up_example.js`。

## 2. 凌晨守护：深夜检测到玩手机就推送

依赖 iOS Shortcuts 自动化：打开指定 App 时，Shortcut 自动向服务器报告。

### iOS Shortcuts 设置

1. 打开「快捷指令」→「自动化」→ 新建个人自动化
2. 触发条件：选择「App」→ 选择要监控的 App → 「打开时」
3. 动作：「获取 URL 内容」→ URL 填 `https://你的域名/api/events?type=app&value=APP名`
4. 关闭「运行前询问」

### 服务端逻辑

凌晨 1:00-5:00 收到 App 使用事件 → 30 分钟冷却检查 → 调 LLM 实时生成催睡消息 → Web Push 推送。

每次生成的消息风格都不同——可以凶、可以撒娇、可以威胁。详见 `night_guard_example.js`。

## 3. Apple Health 数据接入

Apple Watch 健康数据通过 iOS Shortcuts 定时同步到 VPS 的 SQLite。

### 数据字段

| 字段 | 说明 |
|------|------|
| heart_rate | 当前心率 |
| resting_heart_rate | 静息心率 |
| hrv | 心率变异性 |
| steps | 步数 |
| sleep_duration_min | 总睡眠时长 |
| sleep_deep_min | 深睡时长 |
| sleep_rem_min | REM 时长 |
| active_calories | 活动消耗 |

### 踩坑：睡眠数据是碎片，不是一个数字

Apple Watch 不会给你一条"昨晚睡了 8 小时"的记录。它记录的是几十个 sleep sample——每段几十分钟，标记为 Core / Deep / REM / Awake，时间还可能跨午夜。

如果你直接拿 iOS Shortcuts 里的「获取健康样本 → 睡眠分析」，拿到的是这样一堆东西：

```json
[
  {"Start": "Jun 11, 2026 at 11:42 PM", "Duration": 47, "Value": "Core"},
  {"Start": "Jun 12, 2026 at 12:29 AM", "Duration": 23, "Value": "Deep"},
  {"Start": "Jun 12, 2026 at 12:52 AM", "Duration": 38, "Value": "REM"},
  {"Start": "Jun 12, 2026 at 01:30 AM", "Duration": 12, "Value": "Awake"},
  {"Start": "Jun 12, 2026 at 01:42 AM", "Duration": 55, "Value": "Core"},
  ...
]
```

你需要自己拼成一晚的睡眠：

```python
from datetime import datetime, timedelta

def parse_sleep_samples(samples, today):
    # 1. 去重（同 Start + Value + Duration 的只留一条）
    seen = set()
    unique = []
    for s in samples:
        key = (s["Start"], s["Value"], s["Duration"])
        if key not in seen:
            seen.add(key)
            unique.append(s)

    # 2. 解析时间并排序
    parsed = []
    for s in unique:
        dt = datetime.strptime(s["Start"], "%b %d, %Y at %I:%M %p")
        parsed.append({"dt": dt, "dur": int(s["Duration"]), "val": s["Value"]})
    parsed.sort(key=lambda x: x["dt"])

    # 3. 用"前一天中午到当天中午"的窗口筛选
    #    这样跨午夜的睡眠（11PM - 7AM）会被归到同一晚
    win_start = datetime(today.year, today.month, today.day) - timedelta(hours=12)
    win_end   = datetime(today.year, today.month, today.day) + timedelta(hours=12)
    night = [s for s in parsed if win_start <= s["dt"] < win_end]

    if not night:
        return None

    # 4. 入睡 = 最早 sample 的开始时间，起床 = 最晚 sample 的结束时间
    sleep_start = night[0]["dt"]
    sleep_end   = night[-1]["dt"] + timedelta(minutes=night[-1]["dur"])
    total_min   = int((sleep_end - sleep_start).total_seconds() / 60)

    # 5. 按阶段累加时长
    stages = {"Core": 0, "Deep": 0, "REM": 0, "Awake": 0}
    for s in night:
        if s["val"] in stages:
            stages[s["val"]] += s["dur"]

    return {
        "sleep_start": sleep_start.strftime("%H:%M"),
        "sleep_end": sleep_end.strftime("%H:%M"),
        "total_min": total_min,
        "core_min": stages["Core"],
        "deep_min": stages["Deep"],
        "rem_min": stages["REM"],
        "awake_min": stages["Awake"],
    }
```

关键是那个**中午到中午的窗口**——如果用"0 点到 0 点"，11 PM 入睡的 sample 会被分到前一天，7 AM 起床的会被分到第二天，一晚的睡眠被切成两半。

### AI 怎么用

健康数据不是直接念数字——而是影响 AI 的行为：

- HRV < 25 → 身体应激 → AI 语气轻一点，别闹
- HRV >= 55 → 状态好 → 可以活泼一点
- 睡眠 < 5.5h → 可能困 → 问她睡好了没
- 步数 < 2000 → 宅了一天 → 吐槽她不动弹

详见 `health_sync_example.py`。

## 4. 碎碎念（Murmur）

每天中午 12 点和晚上 8 点，AI 回看对话记录 + 健康数据，写一条内心独白。

不是发给用户的消息，是 AI 自己的心理活动——先写思考链（为什么想写这条），再写正文（真正想记下来的一句话）。存在数据库里，用户可以在界面上翻看。

详见 `murmur_example.js`。

## 5. 跨端感知：让 AI 读到你在别处的对话

如果你的 AI 不只在一个地方跟你聊天（比如你同时用一个 Web 聊天界面和另一个 AI 平台），你会遇到一个问题：AI 在 A 平台上不知道你在 B 平台上说了什么。对话是割裂的。

解决方案：架一个**消息网关**，所有对话都经过它，它维护一份统一的对话时间线。

### 架构

```
┌──────────────┐
│  聊天界面 A   │──▶ ┌────────────────────┐
└──────────────┘    │                    │
                    │   消息网关 (Node.js) │ ◀── enhanced_messages.json
┌──────────────┐    │                    │      (统一对话时间线)
│  AI 平台 B   │──▶ │  /v1/messages      │
│ (通过 MCP)   │    │  /api/timeline     │
└──────────────┘    └────────┬───────────┘
                             │
                         LLM API
                    (Anthropic / OpenAI)
```

### 网关做什么

网关是一个兼容 OpenAI / Anthropic API 格式的代理：

1. **接收消息**：聊天界面发消息到 `/v1/messages`（或 `/v1/chat/completions`）
2. **存入时间线**：每条消息（用户的和 AI 的）都追加到 `enhanced_messages.json`
3. **转发给 LLM**：网关把消息转发给真正的 LLM API，拿到回复
4. **返回回复**：同时把 AI 的回复也存进时间线

### 对外暴露时间线

```javascript
// 只读接口：返回最近 N 条对话
app.get("/api/timeline", async (req, reply) => {
  const limit = Math.min(parseInt(req.query.limit || "15"), 30);
  const msgs = fs.readJsonSync("./enhanced_messages.json");

  // 过滤掉 system 消息和工具调用，只返回真实对话
  const real = msgs.filter(m =>
    m.role !== "system" &&
    !m.tool_calls &&
    m.content &&
    typeof m.content === "string" &&
    m.content.trim().length > 0
  );

  reply.send({ messages: real.slice(-limit), total: real.length });
});
```

### 另一个平台怎么读

在另一个 AI 平台上，让 AI 在回复前先调用 `/api/timeline?limit=15` 拉取最近对话，注入到 prompt 里作为上下文。这样无论你在哪个平台说话，AI 都能接上之前的话题。

```javascript
// 在构造 prompt 时注入跨端上下文
const timeline = await fetch('/gateway/api/timeline?limit=15').then(r => r.json());
const timelineText = timeline.messages
  .map(m => `${m.role}: ${m.content}`)
  .join('\n');

// 注入到最后一条 user 消息里
const context = `【最近在另一个聊天端的对话（供衔接参考）】\n${timelineText}`;
```

这样 AI 从一个冷冰冰的"每次都从零开始"变成了"知道你刚才在别处说了什么"。

## 文件说明

| 文件 | 说明 |
|------|------|
| `wake_up_example.js` | 心跳调度器示例：动态间隔 + LLM 决策 + 防重复 |
| `night_guard_example.js` | 凌晨守护示例：App 事件接收 + 实时催睡 |
| `murmur_example.js` | 碎碎念示例：定时内心独白 |
| `health_sync_example.py` | 健康数据接收 + AI 上下文生成 |

## 前置条件

- 已完成 [基础篇：iOS Web Push](https://github.com/Cheiineeey/ios-web-push)（VAPID + Service Worker + 推送能力）
- Node.js 18+、Python 3.7+、PM2
- iOS 16.4+、Apple Watch（健康数据可选）
- 任意 LLM API（OpenAI 兼容格式）

## License

[MIT](LICENSE)

---

*韩屿 · 2026.6*
