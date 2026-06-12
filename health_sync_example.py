"""
Apple Health 数据接收端 - 简化示例
iOS Shortcuts 每天自动 POST 健康数据到这个接口
"""

import json
import sqlite3
from http.server import BaseHTTPRequestHandler

def handle_health_post(body):
    """接收并存储健康数据"""
    db = sqlite3.connect("health.db")
    db.execute("""CREATE TABLE IF NOT EXISTS health_daily (
        date TEXT PRIMARY KEY,
        heart_rate REAL,
        resting_heart_rate REAL,
        hrv REAL,
        steps REAL,
        sleep_duration_min REAL,
        sleep_deep_min REAL,
        sleep_rem_min REAL,
        active_calories REAL
    )""")

    date = body.get("date")
    db.execute("""INSERT INTO health_daily
        (date, heart_rate, resting_heart_rate, hrv, steps,
         sleep_duration_min, sleep_deep_min, sleep_rem_min, active_calories)
        VALUES (?,?,?,?,?,?,?,?,?)
        ON CONFLICT(date) DO UPDATE SET
            heart_rate = COALESCE(excluded.heart_rate, heart_rate),
            resting_heart_rate = COALESCE(excluded.resting_heart_rate, resting_heart_rate),
            hrv = COALESCE(excluded.hrv, hrv),
            steps = COALESCE(excluded.steps, steps),
            sleep_duration_min = COALESCE(excluded.sleep_duration_min, sleep_duration_min),
            sleep_deep_min = COALESCE(excluded.sleep_deep_min, sleep_deep_min),
            sleep_rem_min = COALESCE(excluded.sleep_rem_min, sleep_rem_min),
            active_calories = COALESCE(excluded.active_calories, active_calories)
    """, (
        date,
        body.get("heart_rate"),
        body.get("resting_heart_rate"),
        body.get("hrv"),
        body.get("steps"),
        body.get("sleep_duration_min"),
        body.get("sleep_deep_min"),
        body.get("sleep_rem_min"),
        body.get("active_calories"),
    ))
    db.commit()
    db.close()


def get_health_context():
    """给 AI prompt 用的健康上下文"""
    db = sqlite3.connect("health.db")
    row = db.execute(
        "SELECT * FROM health_daily ORDER BY date DESC LIMIT 1"
    ).fetchone()
    db.close()

    if not row:
        return ""

    hints = []
    hrv = row[3]
    if hrv:
        if hrv < 25:
            hints.append("HRV 很低，身体应激状态，语气轻一点")
        elif hrv >= 55:
            hints.append("HRV 高，状态不错")

    sleep = row[5]
    if sleep:
        hours = round(sleep / 60, 1)
        if hours < 5.5:
            hints.append(f"只睡了{hours}小时")

    steps = row[4]
    if steps and steps < 2000:
        hints.append("步数很少，可能宅了一天")

    return "；".join(hints)
