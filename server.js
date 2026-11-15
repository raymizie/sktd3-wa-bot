'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const pino = require('pino');
const QRCode = require('qrcode');
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    Browsers
} = require('@whiskeysockets/baileys');

const PORT = Number(process.env.PORT || process.env.WA_BOT_PORT || 3088);
const HOST = process.env.WA_BOT_HOST || '0.0.0.0';
const SESSION_DIR = fs.existsSync(path.resolve(__dirname, '..', 'data'))
    ? path.resolve(__dirname, '..', 'data', 'wa_session')
    : path.resolve(__dirname, 'wa_session');

const botState = {
    status: 'starting', // 'starting' | 'connecting' | 'qr_ready' | 'connected' | 'disconnected'
    qr_data_url: null,
    qr_updated_at: null,
    user: null,
    last_error: null,
    updated_at: new Date().toISOString()
};

let sock = null;
let isConnecting = false;
let reconnectTimer = null;
let consecutiveFailCount = 0;

function ensureSessionDir() {
    if (!fs.existsSync(SESSION_DIR)) {
        fs.mkdirSync(SESSION_DIR, { recursive: true });
    }
}

function clearSessionDir() {
    try {
        if (fs.existsSync(SESSION_DIR)) {
            const entries = fs.readdirSync(SESSION_DIR);
            for (const entry of entries) {
                fs.rmSync(path.join(SESSION_DIR, entry), { recursive: true, force: true });
            }
        }
    } catch (e) {
        // Ignore cleanup errors
    }
    ensureSessionDir();
}

function hasCorruptedOrIncompleteSession() {
    try {
        const credsPath = path.join(SESSION_DIR, 'creds.json');
        if (!fs.existsSync(credsPath)) return false;
        const raw = fs.readFileSync(credsPath, 'utf8');
        const creds = JSON.parse(raw);
        // Jika creds.json ada 'me' tetapi 'registered' masih false, atau fail rosak, sesi tersekat dan takkan jana QR
        if (creds && creds.registered === false && creds.me) {
            return true;
        }
        return false;
    } catch (_e) {
        return true;
    }
}

function fetchVersionWithTimeout(timeoutMs = 3500) {
    return Promise.race([
        fetchLatestBaileysVersion(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs))
    ]);
}

function normalizeMalaysianPhoneToDigits(rawPhone) {
    let digits = String(rawPhone || '').replace(/[^0-9]/g, '');
    if (!digits) return '';
    if (digits.startsWith('0')) {
        digits = '60' + digits.slice(1);
    } else if (!digits.startsWith('60') && digits.length >= 9 && digits.length <= 10) {
        digits = '60' + digits;
    }
    return digits;
}

async function startWhatsAppBot() {
    if (isConnecting) return;
    isConnecting = true;
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }

    ensureSessionDir();
    if (hasCorruptedOrIncompleteSession()) {
        clearSessionDir();
    }

    botState.status = 'connecting';
    botState.updated_at = new Date().toISOString();

    try {
        const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
        let version = [2, 3000, 1015901307];
        try {
            const latest = await fetchVersionWithTimeout(3500);
            if (latest && Array.isArray(latest.version)) {
                version = latest.version;
            }
        } catch (_err) {
            // Use fallback version
        }

        sock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: false,
            logger: pino({ level: 'silent' }),
            browser: ['Sistem Relief SKTD3', 'Chrome', '120.0.0'],
            syncFullHistory: false,
            markOnlineOnConnect: false,
            connectTimeoutMs: 30000
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                try {
                    const dataUrl = await QRCode.toDataURL(qr, {
                        width: 280,
                        margin: 2,
                        color: {
                            dark: '#0f172a',
                            light: '#ffffff'
                        }
                    });
                    consecutiveFailCount = 0;
                    botState.status = 'qr_ready';
                    botState.qr_data_url = dataUrl;
                    botState.qr_updated_at = new Date().toISOString();
                    botState.last_error = null;
                    botState.updated_at = new Date().toISOString();
                } catch (qrErr) {
                    botState.last_error = String(qrErr.message || qrErr);
                }
            }

            if (connection === 'open') {
                consecutiveFailCount = 0;
                botState.status = 'connected';
                botState.qr_data_url = null;
                botState.last_error = null;
                const rawId = sock?.user?.id || '';
                const cleanPhone = rawId.split(':')[0].split('@')[0];
                botState.user = {
                    id: rawId,
                    phone: cleanPhone ? '+' + cleanPhone : '',
                    name: sock?.user?.name || 'WhatsApp Sekolah / Penyelia'
                };
                botState.updated_at = new Date().toISOString();
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const invalidSessionCodes = [
                    DisconnectReason.loggedOut,
                    DisconnectReason.badSession,
                    DisconnectReason.forbidden,
                    DisconnectReason.multideviceMismatch,
                    401, 403, 405, 411, 500
                ];
                consecutiveFailCount++;
                const shouldResetSession = invalidSessionCodes.includes(statusCode) || consecutiveFailCount >= 2;

                botState.qr_data_url = null;
                botState.user = null;
                botState.status = 'disconnected';
                botState.last_error = lastDisconnect?.error?.message || `Kod penutupan: ${statusCode || 'unknown'}`;
                botState.updated_at = new Date().toISOString();

                if (shouldResetSession) {
                    consecutiveFailCount = 0;
                    clearSessionDir();
                }

                reconnectTimer = setTimeout(() => {
                    startWhatsAppBot();
                }, 2000);
            }
        });
    } catch (err) {
        botState.status = 'disconnected';
        botState.last_error = String(err.message || err);
        botState.updated_at = new Date().toISOString();
        reconnectTimer = setTimeout(() => {
            startWhatsAppBot();
        }, 4000);
    } finally {
        isConnecting = false;
    }
}

function sendJson(res, statusCode, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
        'Access-Control-Allow-Private-Network': 'true'
    });
    res.end(body);
}

function readJsonBody(req) {
    return new Promise((resolve) => {
        let raw = '';
        req.on('data', (chunk) => {
            raw += chunk;
            if (raw.length > 1024 * 1024) {
                req.destroy();
            }
        });
        req.on('end', () => {
            if (!raw) return resolve({});
            try {
                resolve(JSON.parse(raw));
            } catch (_e) {
                resolve({});
            }
        });
        req.on('error', () => resolve({}));
    });
}

const server = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
        return sendJson(res, 200, { ok: true });
    }

    const urlObj = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);
    const pathname = urlObj.pathname;

    if (req.method === 'GET' && (pathname === '/' || pathname === '/status')) {
        return sendJson(res, 200, {
            ok: true,
            ...botState
        });
    }

    if (req.method === 'POST' && pathname === '/send') {
        const body = await readJsonBody(req);
        const rawPhone = body.phone || body.target || body.to || '';
        const text = String(body.message || body.text || '').trim();
        const digits = normalizeMalaysianPhoneToDigits(rawPhone);

        if (!digits || !text) {
            return sendJson(res, 400, {
                ok: false,
                sent: false,
                message: 'Nombor telefon atau teks mesej tidak lengkap.'
            });
        }

        if (botState.status !== 'connected' || !sock) {
            return sendJson(res, 503, {
                ok: false,
                sent: false,
                status: botState.status,
                message: 'Bot WhatsApp belum disambungkan. Sila imbas kod QR WhatsApp terlebih dahulu.'
            });
        }

        try {
            let targetJid = `${digits}@s.whatsapp.net`;
            try {
                const [checkRes] = await sock.onWhatsApp(digits);
                if (checkRes && checkRes.exists && checkRes.jid) {
                    targetJid = checkRes.jid;
                }
            } catch (_e) {
                // Gunakan targetJid standard jika semakan gagal
            }

            const msgRes = await sock.sendMessage(targetJid, { text });
            return sendJson(res, 200, {
                ok: true,
                sent: true,
                phone: '+' + digits,
                jid: targetJid,
                message_id: msgRes?.key?.id || null,
                message: `Berjaya dihantar terus ke WhatsApp (+${digits}).`
            });
        } catch (err) {
            return sendJson(res, 500, {
                ok: false,
                sent: false,
                message: 'Gagal menghantar mesej WhatsApp: ' + String(err.message || err)
            });
        }
    }

    if (req.method === 'POST' && (pathname === '/logout' || pathname === '/reset-qr')) {
        try {
            if (sock) {
                await sock.logout();
            }
        } catch (_e) {
            // Ignore logout error
        }
        try {
            if (sock && sock.ws) {
                sock.ws.close();
            }
        } catch (_e) {}
        sock = null;
        isConnecting = false;
        clearSessionDir();
        botState.status = 'connecting';
        botState.qr_data_url = null;
        botState.user = null;
        startWhatsAppBot();
        return sendJson(res, 200, {
            ok: true,
            message: 'Sesi WhatsApp telah diset semula. Menjana kod QR baharu...'
        });
    }

    if (req.method === 'POST' && pathname === '/reconnect') {
        const wasConnected = botState.status === 'connected';
        try {
            if (sock && sock.ws) {
                sock.ws.close();
            }
        } catch (_e) {
            // Ignore
        }
        sock = null;
        isConnecting = false;
        if (!wasConnected) {
            clearSessionDir();
            botState.qr_data_url = null;
        }
        startWhatsAppBot();
        return sendJson(res, 200, {
            ok: true,
            message: 'Menyambung semula & menjana kod QR baharu...'
        });
    }

    return sendJson(res, 404, {
        ok: false,
        message: 'Endpoint tidak ditemui.'
    });
});

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        process.exit(0);
    }
});

server.listen(PORT, HOST, () => {
    startWhatsAppBot();
});
