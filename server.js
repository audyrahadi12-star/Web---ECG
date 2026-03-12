const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const mysql = require('mysql2');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Koneksi database
const db = mysql.createConnection({
    host: 'localhost',
    user: 'root',
    password: '',
    database: 'ecg_monitor'
});

db.connect(err => {
    if (err) {
        console.error('❌ MySQL Gagal Terhubung:', err.message);
        process.exit(1);
    }
    console.log('✅ MySQL Terhubung!');
});

app.use(express.static(path.join(__dirname, 'public')));

// Heartbeat
function noop() {}
function heartbeat() { this.isAlive = true; }

const interval = setInterval(function ping() {
    wss.clients.forEach(function each(ws) {
        if (ws.isAlive === false) {
            console.log('🔴 Koneksi timeout, memutus...');
            return ws.terminate();
        }
        ws.isAlive = false;
        ws.ping(noop);
    });
}, 3000);

wss.on('close', () => clearInterval(interval));

// Variabel mode global
let currentMode = 'elliptic'; // default

wss.on('connection', (ws) => {
    console.log('🟢 Client Terhubung! Total:', wss.clients.size);

    ws.isAlive = true;
    ws.on('pong', heartbeat);

    // Kirim mode saat ini ke client baru
    ws.send(JSON.stringify({ type: 'mode', mode: currentMode }));

    // Kirim history
    db.query('SELECT * FROM ecg_records ORDER BY id DESC LIMIT 50', (err, results) => {
        if (err) {
            console.error('❌ Query history gagal:', err.message);
            return;
        }
        ws.send(JSON.stringify({ type: 'history', data: results.reverse() }));
    });

    // Terima data dari ESP32
    ws.on('message', (message) => {
        try {
            const msg = JSON.parse(message);

            // Update mode jika dikirim oleh ESP32
            if (msg.mode !== undefined) {
                currentMode = msg.mode;
                // Broadcast mode ke semua client
                const modeMsg = JSON.stringify({ type: 'mode', mode: currentMode });
                wss.clients.forEach(client => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(modeMsg);
                    }
                });
            }

            if (msg.elliptic) {
                const dataSource = msg.elliptic;
                const count = (dataSource['I'] && Array.isArray(dataSource['I']))
                    ? dataSource['I'].length
                    : 0;

                if (count === 0) return;

                console.log(`📡 Menerima ${count} sample dari ESP32, mode: ${currentMode}`);

                // Siapkan batch insert
                const values = [];
                for (let idx = 0; idx < count; idx++) {
                    const I   = dataSource['I']?.[idx]   ?? 0;
                    const II  = dataSource['II']?.[idx]  ?? 0;
                    const III = dataSource['III']?.[idx] ?? (II - I);
                    const aVR = dataSource['aVR']?.[idx] ?? -((I + II) / 2);
                    const aVL = dataSource['aVL']?.[idx] ?? (I - (II / 2));
                    const aVF = dataSource['aVF']?.[idx] ?? (II - (I / 2));
                    const V1  = dataSource['V1']?.[idx]  ?? 0;
                    const V2  = dataSource['V2']?.[idx]  ?? 0;
                    const V3  = dataSource['V3']?.[idx]  ?? 0;
                    const V4  = dataSource['V4']?.[idx]  ?? 0;
                    const V5  = dataSource['V5']?.[idx]  ?? 0;
                    const V6  = dataSource['V6']?.[idx]  ?? 0;

                    values.push([
                        I, II, III, aVR, aVL, aVF,
                        V1, V2, V3, V4, V5, V6
                    ]);
                }

                // Insert ke MySQL
                const sql = `INSERT INTO ecg_records 
                    (lead_I, lead_II, lead_III, lead_aVR, lead_aVL, lead_aVF,
                     lead_V1, lead_V2, lead_V3, lead_V4, lead_V5, lead_V6) 
                    VALUES ?`;
                db.query(sql, [values], (err) => {
                    if (err) console.error('❌ DB Insert Error:', err.message);
                });

                // Broadcast ke semua client web
                for (let idx = 0; idx < count; idx++) {
                    const payload = JSON.stringify({
                        type: 'realtime',
                        mode: currentMode, // sertakan mode
                        data: {
                            lead_I:   values[idx][0],  lead_II:  values[idx][1],
                            lead_III: values[idx][2],  lead_aVR: values[idx][3],
                            lead_aVL: values[idx][4],  lead_aVF: values[idx][5],
                            lead_V1:  values[idx][6],  lead_V2:  values[idx][7],
                            lead_V3:  values[idx][8],  lead_V4:  values[idx][9],
                            lead_V5:  values[idx][10], lead_V6:  values[idx][11]
                        }
                    });

                    wss.clients.forEach(client => {
                        if (client !== ws && client.readyState === WebSocket.OPEN) {
                            client.send(payload);
                        }
                    });
                }
            }
        } catch (e) {
            console.error('❌ Error parsing pesan WebSocket:', e.message);
        }
    });

    ws.on('close', () => {
        console.log('🔴 Client Terputus. Sisa:', wss.clients.size);
    });

    ws.on('error', (err) => {
        console.error('⚠️ WS Error:', err.message);
    });
});

server.listen(3000, () => {
    console.log('🚀 Server berjalan di http://localhost:3000');
});