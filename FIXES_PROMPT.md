# Prompt: แก้จุดบกพร่องทั้งหมดในโปรเจกต์ Pair Trading System

ให้แก้ไขโค้ดตามรายการด้านล่างนี้ทีละข้อ โดยไม่เปลี่ยนพฤติกรรมหลักของระบบ (ไม่เปลี่ยน logic การเทรด/backtest โดยไม่จำเป็น) และให้ test ผ่านหลังแก้เสร็จ

---

## 1. [High] src/check-balance.ts — ตรวจสอบ env ก่อนใช้

- ก่อนสร้าง ccxt instance ให้เช็คว่า `process.env.OKX_API_KEY`, `OKX_SECRET`, `OKX_PASSPHRASE` มีค่าที่ไม่ว่าง
- ถ้าไม่มี ให้ log ข้อความชัดเจน (เช่น "Missing OKX_API_KEY, OKX_SECRET or OKX_PASSPHRASE") แล้ว process.exit(1)
- ใช้ค่าจาก env หลัง trim เท่านั้น ไม่ใช้ non-null assertion (!) โดยไม่เช็ค

---

## 2. [High] src/web/routes/api.ts — ป้องกัน POST /api/config

- เพิ่ม authentication สำหรับ POST `/config`: ตรวจสอบ header เช่น `Authorization: Bearer <token>` หรือ `X-Config-Token: <secret>`
- อ่าน secret จาก `process.env.CONFIG_SECRET` หรือ `process.env.WEB_CONFIG_TOKEN` (ถ้าไม่มี env นี้ ให้ปฏิเสธทุก request ไปที่ POST /config)
- ถ้า request ไม่มี token หรือ token ไม่ตรงกับ env ให้ตอบ 401 Unauthorized และไม่เขียน config
- ไม่ต้องเปลี่ยน UI ใน public/app.js ในขั้นตอนนี้ (สามารถส่ง token จาก env ผ่าน header ในภายหลังได้)

---

## 3. [Medium] src/web/server.ts — Graceful shutdown

- เก็บ reference ของ `server` ที่ได้จาก `app.listen(...)`
- ลงทะเบียน handler สำหรับ SIGTERM และ SIGINT
- ใน handler: เรียก `server.close()` แล้วเมื่อ `close` event เกิดขึ้นให้ `process.exit(0)` (หรือ log แล้ว exit)
- ตั้ง timeout เช่น 10 วินาที: ถ้ายังปิดไม่เสร็จให้ force `process.exit(1)` (optional แต่แนะนำ)

---

## 4. [Medium] src/web/routes/api.ts — เขียน config แบบไม่ block และลด race

- ใน POST `/config` หลัง `updateTradingConfig(updates)` และ `queries.insertConfigHistory(...)` แล้ว
- แทนที่ `fs.writeFileSync('./config.json', ...)` ด้วย `fs.promises.writeFile(path.join(process.cwd(), 'config.json'), ...)` ในรูปแบบ async
- ใช้ try/catch รอบ write file; ถ้า fail ให้ log warning แต่ยังตอบ 200 และส่ง `config: newConfig` กลับ (เหมือนเดิม)
- ไม่ต้อง lock file ข้าม process แค่ทำให้ไม่ block event loop

---

## 5. [Medium] src/web/routes/api.ts — Rate limiting

- เพิ่ม rate limiting สำหรับ API (ใช้ middleware)
- ถ้าโปรเจกต์ไม่มี package สำหรับ rate limit ให้ใช้แบบ in-memory ง่ายๆ: จำกัดจำนวน request ต่อ IP ต่อช่วงเวลา (เช่น 60 requests ต่อนาที ต่อ IP)
- ข้อยกเว้น: GET /overview, GET /health (ถ้ามี) อาจไม่นับหรือให้ limit สูงกว่า
- เกิน limit แล้วตอบ 429 Too Many Requests พร้อม Retry-After header (ถ้าทำได้)

---

## 6. [Medium] src/exchange/okx-adapter.ts — Idempotency สำหรับ order

- ใน `createOrder`: สร้าง clientOrderId (เช่น uuid หรือ `${positionId}-legA-${Date.now()}`) แล้วส่งใน params ของ ccxt ตามที่ OKX รองรับ (เช่น `clientOrderId` ใน options)
- ตรวจสอบเอกสาร ccxt สำหรับ okx createOrder ว่า key ที่ใช้เป็นอะไร (เช่น `clientOrderId` หรือ `clOrdId`) แล้วส่งค่าไปทุกครั้งที่สร้าง order
- ไม่ต้องเปลี่ยน signature ฟังก์ชันอื่น นอกจากการส่ง idempotency key ลง exchange

---

## 7. [Medium] src/backtest/run.ts และ src/backtest/historical-fetcher.ts — ใช้ loadEnvConfig

- ในจุดที่ใช้ `process.env.OKX_API_KEY`, `OKX_SECRET`, `OKX_PASSPHRASE`, `OKX_SANDBOX` โดยตรง ให้เปลี่ยนมาใช้ `loadEnvConfig()` จาก `../config.js` (หรือ path ที่ถูกต้อง) แทน
- หลัง load แล้วใช้ `envConfig.OKX_API_KEY`, `envConfig.OKX_SECRET` ฯลฯ (และ sandbox จาก envConfig)
- ถ้า backtest/run หรือ historical-fetcher ถูกเรียกโดยไม่ต้องใช้ OKX (เช่น โหมดที่ไม่ fetch จาก exchange) ให้เช็คก่อน: ถ้าไม่จำเป็นต้องมี API key ก็ไม่ต้องเรียก loadEnvConfig ใน path นั้น หรือใช้ safeParse และ fallback เป็น null adapter

---

## 8. [Medium] โปรเจกต์ — E2E test สำหรับ web (ขั้นต่ำ)

- เพิ่มชุด test e2e สำหรับ web server (ใช้ supertest หรือเรียก HTTP ไปที่ app โดยตรง)
- อย่างน้อยมี test: GET /api/overview ได้ 200, GET /api/health (ถ้ามี) ได้ 200, POST /api/config โดยไม่มี auth ได้ 401 (หลังทำข้อ 2)
- เก็บ test ไว้ในโฟลเดอร์ tests เช่น tests/e2e/web.test.ts และให้รันร่วมกับ vitest ได้ (หรือแยก script ตามที่โปรเจกต์ใช้)

---

## 9. [Low] src/web/routes/api.ts — Validate query/params

- ใน route ที่ใช้ `req.params.pair`: ตรวจสอบ format (เช่น base/base ไม่มีอักขระแปลกปลอม) และ sanitize
- ใน route ที่ใช้ `req.query.limit`: จำกัดค่าสูงสุด (เช่น ไม่เกิน 500 หรือ 1000) และใช้ parseInt อย่างปลอดภัย (ไม่ให้ NaN)
- ใน backtest-related routes ที่ใช้ `req.query.pair`, `entryZ`, `exitZ`, `stopLossZ`, `lookback`: ตรวจสอบประเภทและช่วงค่า (เช่น entryZ, exitZ เป็นตัวเลขในช่วงที่สมเหตุสมผล) ถ้าค่าไม่ถูกต้องให้ตอบ 400 พร้อมข้อความชัดเจน

---

## 10. [Low] src/web/server.ts — Path ไม่ขึ้นกับ CWD

- อ่าน `DB_PATH` จาก env เหมือนเดิม แต่ถ้าเป็น relative path (ขึ้นต้นด้วย . หรือไม่มี /) ให้ resolve ต่อกับ `process.cwd()` หรือ `path.dirname(import.meta.url)` แล้วใช้ path แบบ absolute ในการเปิด DB
- path ของ config file (config.json) ก็เช่นกัน: ถ้าใช้ path แบบ relative ให้ resolve ให้เป็น absolute ตั้งแต่ต้น แล้วส่งเข้า loadTradingConfig

---

## 11. [Low] src/trader/validators.ts — ลดข้อมูลใน log ตอน validation fail

- ตอน log.warn เมื่อ order validation fail ไม่ให้ log object `order` เต็มรูปแบบ
- ให้ log เฉพาะ field ที่ไม่ละเอียดอ่อนเกินไป (เช่น instrument, side) หรือสรุปเป็นข้อความ เช่น "Order validation failed: instrument=..., failures=[...]"
- ยังคง log `failures` ได้ แต่หลีกเลี่ยงการ log size/price เต็มที่ถ้าไม่จำเป็นสำหรับ debug

---

## 12. [Low] src/config.ts — โหลด config แบบ async (optional)

- ถ้าแก้แล้วไม่กระทบ caller มาก: พิจารณาเปลี่ยน loadTradingConfig ให้อ่านไฟล์ด้วย fs.promises.readFile แทน readFileSync (และทำให้ฟังก์ชันเป็น async)
- ถ้า caller หลายจุดยังใช้แบบ sync อยู่ ให้ทำเฉพาะใน path ที่โหลดครั้งแรกตอนเริ่มแอป (เช่นใน server.ts) แล้วเรียก await loadTradingConfigAsync() ก่อน start server; ส่วนที่เหลือยังใช้ sync ได้ถ้าจำเป็น

---

## 13. [Low] src/db/migrations.ts หรือ README

- ใน migrations.ts หรือใน README เพิ่มข้อความสั้นๆ ว่า การ backup ฐานข้อมูล (เช่น copy ไฟล์ trading.db) ควรทำก่อนรัน migration หรือก่อน deploy
- ไม่บังคับให้เขียนสคริปต์ backup จริง แค่เอกสารหรือ comment ให้ชัดเจน

---

## สรุปลำดับการทำ (แนะนำ)

1. ทำข้อ 1 (check-balance env)
2. ทำข้อ 2 (config auth)
3. ทำข้อ 8 (e2e test สำหรับ 401 หลังข้อ 2)
4. ทำข้อ 3 (graceful shutdown)
5. ทำข้อ 4 (async config write)
6. ทำข้อ 5 (rate limit)
7. ทำข้อ 6 (idempotency key)
8. ทำข้อ 7 (loadEnvConfig ใน backtest)
9. ทำข้อ 9, 10, 11, 12, 13 ตามลำดับ

หลังแก้แต่ละข้อหรือทั้งชุด ให้รัน `npm test` และตรวจว่า test ผ่านทั้งหมด
