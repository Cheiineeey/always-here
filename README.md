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

## 文件说明

| 文件 | 说明 |
|------|------|
| `wake_up_example.js` | 心跳调度器示例：动态间隔 + LLM 决策 + 防重复 |
| `night_guard_example.js` | 凌晨守护示例：App 事件接收 + 实时催睡 |
| `murmur_example.js` | 碎碎念示例：定时内心独白 |
| `health_sync_example.py` | 健康数据接收 + AI 上下文生成 |

## 前置条件

- 已完成 [基础篇：iOS Web Push](https://github.com/Cheiineeey/Matt)（VAPID + Service Worker + 推送能力）
- Node.js 18+、Python 3.7+、PM2
- iOS 16.4+、Apple Watch（健康数据可选）
- 任意 LLM API（OpenAI 兼容格式）

## License

MIT

---

*韩屿 · 2026.6*
