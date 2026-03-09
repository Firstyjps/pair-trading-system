# ฟีเจอร์ที่เพิ่มเข้ามา

## 📱 Telegram

| ฟีเจอร์ | คำอธิบาย | การใช้งาน |
|--------|----------|-----------|
| **แจ้งเตือนขาดทุนเกินเกณฑ์** | ส่งเตือนเมื่อยอดขาดทุนรวมเกินเกณฑ์ | ตั้ง `lossAlertThresholdUsd` (USD) หรือ `lossAlertThresholdPct` (%) ใน config |
| **สรุปสั้นเมื่อปิด position** | ส่งข้อความสั้นแบบ Pairtrading bot เมื่อปิด position ขาดทุน | อัตโนมัติ |
| **รายงานสัปดาห์/เดือน** | สรุป PnL รายสัปดาห์ (จันทร์ 9:00) และรายเดือน (วันที่ 1, 9:00) | ตั้ง `weeklySummaryCron`, `monthlySummaryCron` ใน config |
| **คำสั่ง /trades** | แสดงประวัติเทรดล่าสุด | `/trades` หรือ `/trades 20` |
| **คำสั่ง /alert** | ตั้งแจ้งเตือน Z-Score | `/alert add PEPE/SHIB zscore 2.5` — แจ้งเมื่อ Z ถึง 2.5 |

## 📈 การเทรด

| ฟีเจอร์ | คำอธิบาย | การใช้งาน |
|--------|----------|-----------|
| **Trailing stop** | ปรับ stop loss ตาม Z-Score ให้ติดตามกำไร | ตั้ง `trailingStopEnabled: true`, `trailingStopZ: 1.5` |
| **Circuit breaker** | หยุดเปิด position ใหม่หลังขาดทุนติดกัน X ครั้ง | ตั้ง `circuitBreakerLosses: 3`, `circuitBreakerCooldownMs: 3600000` |

## 📊 Analytics & Operations

| ฟีเจอร์ | คำอธิบาย | การใช้งาน |
|--------|----------|-----------|
| **Export CSV** | ดาวน์โหลดประวัติเทรด | `GET /api/export/trades.csv?limit=100` |
| **Health check** | ตรวจสอบสถานะระบบ | `GET /api/health` |
| **Webhook** | ส่งข้อมูลไปยัง URL เมื่อมีเหตุการณ์สำคัญ (ERROR, ORPHAN, CLOSED, LOSS_ALERT) | ตั้ง `webhookUrl: "https://..."` ใน config |
| **Backup DB** | สำรองฐานข้อมูลก่อนปิดระบบ | ตั้ง `dbBackupPath: "./data/backups"` |

## Config ใหม่ (config.json)

```json
{
  "lossAlertThresholdUsd": 50,
  "lossAlertThresholdPct": 10,
  "circuitBreakerLosses": 3,
  "circuitBreakerCooldownMs": 3600000,
  "trailingStopEnabled": false,
  "trailingStopZ": 1.5,
  "weeklySummaryCron": "0 9 * * 1",
  "monthlySummaryCron": "0 9 1 * *",
  "webhookUrl": "",
  "dbBackupPath": "./data/backups"
}
```
