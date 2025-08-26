/**
 * WhatsApp Bot Multi‑Fitur (Baileys)
 * Platform: Node.js (Windows/PowerShell, Kali Linux, VSCode)
 * 
 * ---- Persiapan ----
 * 1) Node.js ≥ 16 (cek: node -v)
 * 2) NPM packages (install di folder project):
 *    npm init -y
 *    npm install @whiskeysockets/baileys qrcode-terminal axios sharp fluent-ffmpeg ytdl-core google-tts-api mime-types qrcode dotenv
 * 3) FFmpeg (untuk audio/video):
 *    - Windows (PowerShell): winget install Gyan.FFmpeg
 *    - Kali/Ubuntu: sudo apt update && sudo apt install -y ffmpeg
 * 4) Buat file .env (opsional):
 *    OPENAI_API_KEY=sk-......   # bila ingin fitur !ai
 *    OPENWEATHER_KEY=xxxxxxxx   # bila ingin fitur !weather (opsional, endpoint disiapkan)
 *    OWNER_NUMBER=62xxxxxxxxxxx  # nomor owner untuk fitur !owner
 * 
 * Jalankan: node index.js
 */

const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  jidNormalizedUser,
  downloadMediaMessage
} = require('@whiskeysockets/baileys')
const qrcode = require('qrcode-terminal')
const axios = require('axios')
const sharp = require('sharp')
const ffmpeg = require('fluent-ffmpeg')
const fs = require('fs')
const path = require('path')
const { v4: uuidv4 } = require('uuid')
const ytdl = require('ytdl-core')
const gtts = require('google-tts-api')
const mime = require('mime-types')
const QRCode = require('qrcode')
require('dotenv').config()

// ---------- UTIL ----------
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const TMP = path.join(__dirname, 'tmp')
if (!fs.existsSync(TMP)) fs.mkdirSync(TMP)

function isCmd(text, prefix = '!') {
  return typeof text === 'string' && text.trim().startsWith(prefix)
}

function parseCmd(text, prefix = '!') {
  const t = text.trim()
  const [cmd, ...argsArr] = t.replace(prefix, '').split(' ')
  const args = argsArr.join(' ').trim()
  return { cmd: cmd?.toLowerCase() || '', args, argsArr }
}

async function bufferToStickerFromImage(buffer) {
  // Convert any image to WebP sticker
  return sharp(buffer)
    .resize(512, 512, { fit: 'inside' })
    .webp({ quality: 95 })
    .toBuffer()
}

async function stickerToImage(buffer) {
  // Many WA stickers are webp → convert to png
  return sharp(buffer).png().toBuffer()
}

async function downloadQuotedMedia(sock, m) {
  try {
    const msg = m.message?.extendedTextMessage?.contextInfo?.quotedMessage
      ? { message: m.message.extendedTextMessage.contextInfo.quotedMessage }
      : m
    const buff = await downloadMediaMessage(msg, 'buffer', {})
    return buff
  } catch (e) {
    return null
  }
}

async function sendReply(sock, to, text, quoted) {
  return sock.sendMessage(to, { text }, { quoted })
}

async function getGroupAdmins(sock, jid) {
  const meta = await sock.groupMetadata(jid)
  return meta.participants.filter(p => p.admin).map(p => p.id)
}

function isUserAdmin(userJid, adminList) {
  const norm = jidNormalizedUser(userJid)
  return adminList.includes(norm)
}

// ---------- BOT CORE ----------
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('./session')
  const { version } = await fetchLatestBaileysVersion()

  const sock = makeWASocket({
    auth: state,
    version,
    printQRInTerminal: true,
    // fancy QR in terminal
    qrTimeout: 60_000,
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update
    if (qr) qrcode.generate(qr, { small: true })
    if (connection === 'close') {
      const reason = lastDisconnect?.error?.output?.statusCode
      if (reason !== DisconnectReason.loggedOut) startBot()
    } else if (connection === 'open') {
      console.log('✅ Bot tersambung!')
    }
  })

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const m = messages[0]
    if (!m.message || m.key.fromMe) return

    const from = m.key.remoteJid
    const isGroup = from.endsWith('@g.us')

    // Ambil teks pesan
    const text = (
      m.message.conversation ||
      m.message.extendedTextMessage?.text ||
      m.message.imageMessage?.caption ||
      m.message.videoMessage?.caption ||
      ''
    ).trim()

    // Prefix & parsing command
    const prefix = '!'
    const sender = m.key.participant || m.key.remoteJid

    // Auto‑read basic commands only
    if (!isCmd(text, prefix)) return

    const { cmd, args } = parseCmd(text, prefix)
    console.log(`[CMD] ${cmd} | args: ${args}`)

    // ------------- COMMANDS -------------
    try {
      switch (cmd) {
        case 'menu': {
          const menu = `
*🤖 WA Bot – Menu*

• !ping – Cek bot
• !owner – Info owner
• !sticker – Reply gambar untuk jadi stiker
• !toimg – Reply stiker jadi gambar
• !tovn – Reply audio/video jadi VN (PTT)
• !tts <lang>|<teks> – Text‑to‑speech (contoh: !tts id|halo)
• !short <url> – Shorten URL (tinyurl)
• !qrcode <teks/url> – Generate QR ke gambar
• !ytmp3 <url> – Unduh audio YouTube (≤ 10 MB)
• !ytmp4 <url> – Unduh video YouTube (≤ 15 MB)
• !ai <prompt> – Jawaban AI (butuh OPENAI_API_KEY)
• !weather <kota> – Cuaca (butuh OPENWEATHER_KEY)

• (Group only) !kick @user | !add 62xxx | !promote @user | !demote @user
          `.trim()
          await sendReply(sock, from, menu, m)
          break
        }

        case 'ping': {
          await sendReply(sock, from, '🏓 Pong!', m)
          break
        }

        case 'owner': {
          const num = process.env.OWNER_NUMBER || 'Set OWNER_NUMBER di .env'
          await sendReply(sock, from, `👤 Owner: ${num}`, m)
          break
        }

        case 'sticker': {
          // Reply ke gambar
          const quoted = m.message?.extendedTextMessage?.contextInfo?.quotedMessage
          const hasImage = quoted?.imageMessage || m.message.imageMessage
          if (!hasImage) return sendReply(sock, from, 'Reply *gambar* dengan caption !sticker', m)
          const buff = await downloadQuotedMedia(sock, m)
          if (!buff) return sendReply(sock, from, 'Gagal ambil media.', m)
          const webp = await bufferToStickerFromImage(buff)
          await sock.sendMessage(from, { sticker: webp }, { quoted: m })
          break
        }

        case 'toimg': {
          // Reply ke stiker
          const quoted = m.message?.extendedTextMessage?.contextInfo?.quotedMessage
          const hasSticker = quoted?.stickerMessage || m.message.stickerMessage
          if (!hasSticker) return sendReply(sock, from, 'Reply *stiker* dengan !toimg', m)
          const buff = await downloadQuotedMedia(sock, m)
          if (!buff) return sendReply(sock, from, 'Gagal ambil stiker.', m)
          const png = await stickerToImage(buff)
          await sock.sendMessage(from, { image: png, caption: '✅ Done' }, { quoted: m })
          break
        }

        case 'tovn': {
          // Reply ke audio atau video → kirim sebagai PTT
          const buff = await downloadQuotedMedia(sock, m)
          if (!buff) return sendReply(sock, from, 'Reply audio/video dengan !tovn', m)
          const inFile = path.join(TMP, `${uuidv4()}.input`)
          const outFile = path.join(TMP, `${uuidv4()}.opus`)
          fs.writeFileSync(inFile, buff)
          await new Promise((resolve, reject) => {
            ffmpeg(inFile)
              .audioCodec('libopus')
              .toFormat('opus')
              .on('end', resolve)
              .on('error', reject)
              .save(outFile)
          })
          const out = fs.readFileSync(outFile)
          await sock.sendMessage(from, { audio: out, ptt: true, mimetype: 'audio/ogg; codecs=opus' }, { quoted: m })
          fs.unlinkSync(inFile); fs.unlinkSync(outFile)
          break
        }

        case 'tts': {
          if (!args.includes('|')) return sendReply(sock, from, 'Format: !tts <lang>|<teks>\nContoh: !tts id|halo semua', m)
          const [lang, ...tArr] = args.split('|')
          const teks = tArr.join('|').trim()
          try {
            const url = gtts.getAudioUrl(teks, { lang: lang.trim(), slow: false })
            const { data } = await axios.get(url, { responseType: 'arraybuffer' })
            await sock.sendMessage(from, { audio: Buffer.from(data), mimetype: 'audio/mpeg' }, { quoted: m })
          } catch (e) {
            await sendReply(sock, from, 'Gagal TTS. Pastikan kode bahasa benar (id, en, ja, dll).', m)
          }
          break
        }

        case 'short': {
          if (!args) return sendReply(sock, from, 'Kirim: !short <url>', m)
          try {
            const { data } = await axios.get(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(args)}`)
            await sendReply(sock, from, `🔗 Short URL: ${data}`, m)
          } catch {
            await sendReply(sock, from, 'Gagal short URL.', m)
          }
          break
        }

        case 'qrcode': {
          if (!args) return sendReply(sock, from, 'Kirim: !qrcode <teks/url>', m)
          const png = await QRCode.toBuffer(args, { width: 512 })
          await sock.sendMessage(from, { image: png, caption: 'QR Code' }, { quoted: m })
          break
        }

        case 'ytmp3': {
          if (!args || !ytdl.validateURL(args)) return sendReply(sock, from, 'Kirim: !ytmp3 <url YouTube>', m)
          try {
            const id = uuidv4()
            const out = path.join(TMP, id + '.mp3')
            await new Promise((resolve, reject) => {
              const stream = ytdl(args, { filter: 'audioonly', quality: 'highestaudio' })
              ffmpeg(stream)
                .audioBitrate(128)
                .save(out)
                .on('end', resolve)
                .on('error', reject)
            })
            const stat = fs.statSync(out)
            if (stat.size > 10 * 1024 * 1024) { // 10 MB
              fs.unlinkSync(out)
              return sendReply(sock, from, 'File >10MB. Gunakan video lebih pendek.', m)
            }
            await sock.sendMessage(from, { document: fs.readFileSync(out), mimetype: 'audio/mpeg', fileName: 'audio.mp3' }, { quoted: m })
            fs.unlinkSync(out)
          } catch (e) {
            await sendReply(sock, from, 'Gagal ambil audio.', m)
          }
          break
        }

        case 'ytmp4': {
          if (!args || !ytdl.validateURL(args)) return sendReply(sock, from, 'Kirim: !ytmp4 <url YouTube>', m)
          try {
            const id = uuidv4()
            const out = path.join(TMP, id + '.mp4')
            await new Promise((resolve, reject) => {
              const stream = ytdl(args, { quality: '18' }) // 360p
              ffmpeg(stream)
                .videoCodec('libx264')
                .format('mp4')
                .save(out)
                .on('end', resolve)
                .on('error', reject)
            })
            const stat = fs.statSync(out)
            if (stat.size > 15 * 1024 * 1024) { // 15 MB
              fs.unlinkSync(out)
              return sendReply(sock, from, 'File >15MB. Gunakan video lebih pendek.', m)
            }
            await sock.sendMessage(from, { video: fs.readFileSync(out), caption: '✅ Done' }, { quoted: m })
            fs.unlinkSync(out)
          } catch (e) {
            await sendReply(sock, from, 'Gagal ambil video.', m)
          }
          break
        }

        case 'ai': {
          if (!args) return sendReply(sock, from, 'Kirim: !ai <pertanyaan>', m)
          const key = process.env.OPENAI_API_KEY
          if (!key) return sendReply(sock, from, 'OPENAI_API_KEY belum diset di .env', m)
          try {
            // OpenAI Chat Completions (v1)
            const { data } = await axios.post('https://api.openai.com/v1/chat/completions', {
              model: 'gpt-4o-mini',
              messages: [
                { role: 'system', content: 'You are a helpful assistant in WhatsApp bot.' },
                { role: 'user', content: args }
              ]
            }, { headers: { Authorization: `Bearer ${key}` } })
            const reply = data.choices?.[0]?.message?.content?.trim() || 'Tidak ada jawaban.'
            await sendReply(sock, from, reply, m)
          } catch (e) {
            await sendReply(sock, from, 'Gagal memanggil AI.', m)
          }
          break
        }

        case 'weather': {
          if (!args) return sendReply(sock, from, 'Kirim: !weather <kota>', m)
          const api = process.env.OPENWEATHER_KEY
          if (!api) return sendReply(sock, from, 'OPENWEATHER_KEY belum diset di .env', m)
          try {
            const url = `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(args)}&appid=${api}&units=metric&lang=id`
            const { data } = await axios.get(url)
            const desc = data.weather?.[0]?.description
            const temp = data.main?.temp
            await sendReply(sock, from, `Cuaca *${data.name}*: ${desc}, ${temp}°C`, m)
          } catch (e) {
            await sendReply(sock, from, 'Gagal ambil cuaca.', m)
          }
          break
        }

        // ---- GROUP TOOLS ----
        case 'kick':
        case 'promote':
        case 'demote':
        case 'add': {
          if (!isGroup) return sendReply(sock, from, 'Perintah khusus grup.', m)
          const admins = await getGroupAdmins(sock, from)
          if (!isUserAdmin(sender, admins)) return sendReply(sock, from, 'Hanya admin grup yang boleh.', m)

          if (cmd === 'add') {
            if (!args) return sendReply(sock, from, 'Format: !add 62xxxxxxxx', m)
            const jid = args.replace(/[^0-9]/g, '') + '@s.whatsapp.net'
            await sock.groupParticipantsUpdate(from, [jid], 'add').catch(() => sendReply(sock, from, 'Gagal menambah.', m))
            return
          }

          const context = m.message?.extendedTextMessage?.contextInfo
          const mentions = context?.mentionedJid || []
          if (!mentions.length) return sendReply(sock, from, 'Tag anggota yang dituju.', m)

          if (cmd === 'kick') {
            await sock.groupParticipantsUpdate(from, mentions, 'remove').catch(() => sendReply(sock, from, 'Gagal kick.', m))
          } else if (cmd === 'promote') {
            await sock.groupParticipantsUpdate(from, mentions, 'promote').catch(() => sendReply(sock, from, 'Gagal promote.', m))
          } else if (cmd === 'demote') {
            await sock.groupParticipantsUpdate(from, mentions, 'demote').catch(() => sendReply(sock, from, 'Gagal demote.', m))
          }
          break
        }

        default:
          await sendReply(sock, from, 'Perintah tidak dikenal. Ketik *!menu*', m)
      }
    } catch (err) {
      console.error('CMD Error:', err)
      await sendReply(sock, from, 'Terjadi kesalahan saat memproses perintah.', m)
    }
  })
}

startBot().catch(e => console.error('Fatal:', e))
// End of file