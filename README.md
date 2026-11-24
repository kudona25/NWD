# NWD — Logical Topology แบบ real-time (CDP + LLDP)

ระบบจะ SSH เข้า **Seed Switch** (core) แล้วอ่าน `show cdp neighbors detail`, `show lldp neighbors detail` และ `show interfaces status` จากนั้นไล่ลงไปทีละ switch แบบ BFS แล้ววาดเป็นแผนที่ที่อัปเดตเองทุก 5 นาที
คำศัพท์ที่ใช้ในระบบดูได้ที่ [CONTEXT.md](CONTEXT.md)

![License: MIT](https://img.shields.io/badge/License-MIT-green.svg) ![Python 3.11+](https://img.shields.io/badge/Python-3.11%2B-blue.svg) ![Platform: Windows](https://img.shields.io/badge/Platform-Windows%2010%2F11-lightgrey.svg)

## ความสามารถหลัก

- **ค้นหา topology อัตโนมัติ** — เริ่มจาก Seed Switch แล้วไล่ CDP/LLDP neighbor แบบ BFS ทั้ง site
- **อัปเดต real-time** — crawl ใหม่ทุก 5 นาที (หรือกด Rescan) แล้ว push การเปลี่ยนแปลงไปหน้าเว็บผ่าน WebSocket
- **ตรวจจับการเปลี่ยนแปลง** — อุปกรณ์/สายที่เพิ่ม หาย หรือย้าย port จะถูกบันทึกเป็น Change Event พร้อมสถานะ Suspect กันแจ้งเตือนพลาด
- **แยกประเภทสาย** — UTP / Fiber MM / Fiber SM / DAC จากชนิด SFP และแก้เองได้รายเส้น
- **รองรับ Access Point** — เห็น AP (เช่น Cisco, Aruba) จาก CDP/LLDP เป็นปลายทางบนแผนที่ โดยไม่ล็อกอินเข้า AP
- **Credential เข้ารหัส** — รหัสผ่าน switch เก็บใน SQLite แบบเข้ารหัส (Fernet) กุญแจแยกไฟล์
- **SSH + Telnet fallback** — ตั้ง credential กลางหรือ override ราย IP ได้
- **เปิด terminal เข้า switch ได้จากแผนที่** (Windows Terminal / cmd)
- **ทำงาน offline ได้ทั้งหมด** และมีชุดพกพาที่ไม่ต้องติดตั้ง Python
- **อ่านอย่างเดียว** — ไม่มีการแก้ config บน switch

## เริ่มใช้งาน (Windows 11)

1. ติดตั้ง Python 3.11 ขึ้นไปจาก python.org (ตอนติดตั้งติ๊ก **Add python.exe to PATH**)
2. ดับเบิลคลิก `start.bat`
   ครั้งแรกจะสร้าง `.venv` และติดตั้ง package ใช้เวลาประมาณ 1–2 นาที จากนั้นเบราว์เซอร์จะเปิด http://127.0.0.1:8000 ให้เอง
3. ไปที่แท็บ **ตั้งค่า** ใส่ Seed Switch IP, username/password/enable และ Allowed Subnets แล้วกด **บันทึก** ต่อด้วย **Rescan**

ถ้าจะปิดระบบ ให้ปิดหน้าต่าง cmd

### แบบพกพา (ไม่ต้องติดตั้ง Python บนเครื่องปลายทาง)

บนเครื่องที่มีเน็ต รัน `powershell -ExecutionPolicy Bypass -File tools\make-portable.ps1` ครั้งเดียว
จะได้ `runtime\python` (Python + package ทั้งหมด ~75 MB) จากนั้น copy ทั้งโฟลเดอร์ NWD ไปเครื่อง Windows 10/11 x64 เครื่องไหนก็ได้ แล้วดับเบิลคลิก `start.bat`
ไม่ต้องติดตั้ง Python และไม่ต้องต่อเน็ต — `start.bat` ใช้ `runtime\python` ก่อนเสมอถ้ามี

ง่ายกว่านั้น: แท็บ **ตั้งค่า** → **⬇ ดาวน์โหลด zip** ได้ชุดโปรแกรม + Python พกพา (สร้าง `runtime\python` ให้เองถ้ายังไม่มี) โดย**ไม่มี** `data` (แผนที่ / credential) ติดไป

ห้าม copy `.venv` ไปเครื่องอื่น (ใช้ได้เฉพาะเครื่องที่สร้าง) — ถ้าติดไป `start.bat` จะสร้างใหม่ให้เอง

> ระบบ bind อยู่ที่ `127.0.0.1` เครื่องอื่นใน LAN จึงเข้าไม่ได้ ซึ่งตั้งใจไว้แบบนี้ เพราะระบบเก็บ credential ของ switch ไว้

## สิ่งที่ switch ต้องมี

- เปิด SSH และ account ที่ใช้ต้องได้ privilege 15 (หรือใส่ enable secret ไว้)
- เปิด `cdp run` (ค่าเริ่มต้นเปิดอยู่แล้ว)
- เปิด `lldp run` เพื่อให้เห็น AP Aruba ซึ่งส่งแค่ LLDP
- ใช้คำสั่งอ่านอย่างเดียว ระบบไม่แก้ config ใดๆ บน switch

### Timeout

**Timeout ต่อ switch** ในแท็บตั้งค่า (ค่าเริ่มต้น 60 วินาที ตั้งได้ 10–600) คือเวลาสูงสุดของ switch หนึ่งตัว นับตั้งแต่เริ่มเชื่อมต่อจนอ่านคำสั่งครบ
ถ้าเกินเวลานี้ switch ตัวนั้นจะเป็น "เข้าไม่ได้" พร้อมหมายเหตุ `TimeoutError` แล้ว crawl จะทำต่อทันที ไม่ต้องรอ
ถ้าไม่มีเครื่องตอบเลย (IP ผิดหรือ firewall บล็อก) ระบบจะเลิกรอเองภายในประมาณ 8 วินาที
ถ้า switch ตอบช้าจริง (link ไกลหรือ CPU สูง) และโดน timeout บ่อย ให้เพิ่มค่านี้

### Telnet

มี 2 แบบ:
- **ทั้งระบบ:** ติ๊ก "ลอง Telnet เมื่อ SSH ถูกปฏิเสธ" ใน Default Credential ระบบจะเปลี่ยนไปใช้ telnet เฉพาะตอนที่ port 22 ตอบ refused ถ้า timeout หรือรหัสผิดจะไม่ลอง telnet
- **รายตัว:** เพิ่ม override ของ IP นั้นแล้วเลือก Protocol = Telnet ตัวที่ตั้งแบบนี้จะใช้ telnet อย่างเดียวและไม่ fallback

switch ที่เข้าด้วย telnet จะมีป้าย **⚠ TELNET** บนแผนที่ และมีบันทึกใน event log ตอนเปลี่ยนจาก SSH เป็น telnet
telnet ส่งรหัสผ่านแบบไม่เข้ารหัสทุกรอบ crawl จึงควรเปิด SSH บน switch ตัวนั้นเมื่อมีโอกาส

## สีบนแผนที่

| อุปกรณ์ | ความหมาย |
|---|---|
| ขอบเขียว | ปกติ |
| ขอบเหลือง | Suspect: switch ตัวแม่เข้าไม่ได้ในรอบนี้ ถ้าไม่เจอซ้ำอีกรอบจะเปลี่ยนเป็น "หายไป" |
| ขอบแดง | หายไป: ค้างอยู่จนกว่าจะคลิกแล้วกด **รับทราบ** |
| ขอบเทา | ล็อกอินไม่ได้ / ไม่มี IP / อยู่นอก Allowed Subnets / เกิน hop |

สีของเส้นบอกประเภทสาย: เทา = UTP, ฟ้าน้ำทะเล = Fiber MM, เหลือง = Fiber SM, ม่วง = DAC, เส้นประ = Unknown หรือ Suspect
ถ้าสายใน Link เดียวกันมีหลายประเภท เส้นจะเป็นจุดสีขาวพร้อมป้าย `×2 · ผสม` คลิกที่เส้นเพื่อดูประเภทของแต่ละสาย
เส้นที่ถ้าลากตรงแล้วจะทับอุปกรณ์ตัวอื่น ระบบจะวาดเป็นเส้นโค้งอ้อมให้เอง
ถ้าเส้นเป็นสีส้มพร้อมป้าย `×1/2` แปลว่ามีสายบางเส้นใน Link นั้นหลุด
ประเภทสายตรวจจากชนิด SFP ที่ switch รายงาน ถ้าไม่ตรงกับของจริง คลิกที่เส้นแล้วเลือกใหม่ได้

ลากอุปกรณ์ไปวางตรงไหนก็ได้ ระบบจะจำตำแหน่งไว้ ถ้าต้องการกลับไปใช้การจัดอัตโนมัติ ให้กดปุ่ม **จัดใหม่อัตโนมัติ** สองครั้ง

## ไฟล์ข้อมูล

ข้อมูลทั้งหมดอยู่ในโฟลเดอร์ `data\`:
- `nwd.db` (SQLite) เก็บ topology, event และ credential ที่เข้ารหัสแล้ว
- `secret.key` กุญแจที่ใช้ถอดรหัสรหัสผ่าน **ต้องสำรองคู่กับ nwd.db เสมอ** ถ้าไฟล์นี้หาย ต้องตั้งรหัสผ่านใหม่ทั้งหมด

## โครงสร้างโค้ด

```
app/parsers.py   แปลงผลคำสั่ง CLI เป็นข้อมูล neighbor, ระบุ switch/AP, ระบุประเภทสาย
app/crawler.py   SSH (Netmiko) + BFS → Snapshot
app/state.py     เทียบ Snapshot กับแผนที่เดิม และใช้กฎ Suspect/down → Change Event
app/main.py      FastAPI, scheduler, WebSocket, REST API
static/          หน้าเว็บ (vis-network เก็บไว้ในเครื่อง ใช้งานได้โดยไม่ต้องต่ออินเทอร์เน็ต)
tests/           pytest + network จำลอง
```

ทดสอบโดยไม่ต้องมี switch จริง:

```
.venv\Scripts\python -m pytest -q tests
.venv\Scripts\python -m uvicorn tests.fake_server:app --port 8001
```

คำสั่งที่สองจะเปิด network จำลองที่ http://127.0.0.1:8001 ให้ตั้งค่า Seed เป็น `10.10.1.1` และใส่ user/pass อะไรก็ได้ ข้อมูลของโหมดจำลองจะแยกไปอยู่ใน `data-fake\` จึงไม่ปนกับข้อมูลจริง

โครงสร้างโฟลเดอร์อื่นๆ:

```
app/crypto.py           เข้ารหัส/ถอดรหัส credential ด้วยกุญแจใน data/secret.key
app/db.py               schema และ helper ของ SQLite
tools/make-portable.ps1 สร้าง runtime\python สำหรับชุดพกพา
docs/adr/               บันทึกการตัดสินใจด้านสถาปัตยกรรม (ADR)
CONTEXT.md              คำศัพท์ของระบบ (Seed Switch, Crawl, Suspect ฯลฯ)
```

## REST API

หน้าเว็บคุยกับ backend ผ่าน API ต่อไปนี้ (ทั้งหมดอยู่ที่ `127.0.0.1:8000`)

| Method | Path | หน้าที่ |
|---|---|---|
| GET | `/api/topology` | อุปกรณ์และสายทั้งหมดบนแผนที่ |
| GET | `/api/events?limit=300` | Change Event ล่าสุด |
| GET | `/api/status` | สถานะ crawl ปัจจุบัน |
| POST | `/api/rescan` | สั่ง crawl ทันที |
| GET / PUT | `/api/settings` | อ่าน/บันทึก Seed, credential, Allowed Subnets, timeout |
| GET / PUT / DELETE | `/api/overrides` | credential/protocol ราย IP |
| POST / DELETE | `/api/positions` | บันทึก/ล้างตำแหน่งอุปกรณ์ที่ลากเอง |
| POST | `/api/cables/media` | แก้ประเภทสาย |
| POST | `/api/cables/ack` | รับทราบสายที่หลุด |
| POST | `/api/devices/ack` | รับทราบอุปกรณ์ที่หายไป |
| DELETE | `/api/devices` | ลบอุปกรณ์ออกจากแผนที่ |
| POST | `/api/devices/terminal` | เปิด SSH/Telnet terminal เข้าอุปกรณ์ (Windows) |
| DELETE | `/api/topology?events=false` | ล้างแผนที่ (ย้าย site) |
| GET | `/api/package` | ดาวน์โหลด zip ชุดพกพา (ไม่มี `data\`) |
| WS | `/ws` | push การเปลี่ยนแปลงแบบ real-time |

## ความปลอดภัย

- ห้าม commit โฟลเดอร์ `data\` ขึ้น git (มี credential และ `secret.key`) — `.gitignore` กันไว้แล้ว
- ระบบ bind เฉพาะ `127.0.0.1` ถ้าจะเปิดให้เครื่องอื่นเข้าต้องทำ reverse proxy + authentication เอง
- ใช้ account บน switch ที่มีสิทธิ์น้อยที่สุดเท่าที่อ่านคำสั่ง `show` ได้

## License

เผยแพร่ภายใต้ [MIT License](LICENSE) — ใครจะใช้ แก้ไข แจกจ่าย หรือใช้เชิงพาณิชย์ก็ได้ ขอแค่คงข้อความลิขสิทธิ์และ license ไว้

**ไม่มีการรับประกันใดๆ และผู้พัฒนาไม่รับผิดชอบต่อความเสียหายใดๆ** ที่เกิดจากการใช้งานซอฟต์แวร์นี้ (ซอฟต์แวร์ให้มา "ตามสภาพ" / AS IS) ผู้ใช้ต้องทดสอบและรับความเสี่ยงเอง โดยเฉพาะเมื่อใช้กับระบบเครือข่ายจริง
