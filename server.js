const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
  next();
});

const PORT = 3000;

// CAMBIA ESTAS 4 COSAS
const BOT_TOKEN = '8216481031:AAFuClYkvFOPZ7VSRvtkKA0dcvqSEEA5bws';
const CHAT_ID = '';
const SUPPORT_URL = 'https://t.me/tu_soporte';
const RULES_TEXT = `📜 Reglas del sistema

1. Usa el panel para controlar estados.
2. Verifica tus perfiles antes de trabajar.
3. Las fotos pueden no ser en vivo.
4. Si necesitas ayuda, usa el botón Contactar.`;

// archivos locales
const DATA_FILE = path.join(__dirname, 'data.json');
const STATE_FILE = path.join(__dirname, 'bot_state.json');
const DATA_BACKUP_FILE = path.join(__dirname, 'data.backup.json');
const STATE_BACKUP_FILE = path.join(__dirname, 'bot_state.backup.json');

// =========================
// BLOQUEOS DE CICLO
// =========================
let telegramEnProceso = false;
let cicloEnProceso = false;

// =========================
// COLA REANUDAR TODAS
// =========================
const INTERVALO_REANUDAR_MS = 45000;

// =========================
// UTILIDADES SEGURAS JSON
// =========================
function existeArchivoSeguro(file) {
  try {
    return fs.existsSync(file);
  } catch {
    return false;
  }
}

function copiarArchivoSiExiste(origen, destino) {
  try {
    if (existeArchivoSeguro(origen)) {
      fs.copyFileSync(origen, destino);
      return true;
    }
  } catch (e) {
    console.log(`No se pudo crear backup de ${origen}:`, e.message);
  }
  return false;
}

function guardarJSONSeguro(file, backupFile, data) {
  const tempFile = `${file}.tmp`;

  try {
    if (existeArchivoSeguro(file)) {
      copiarArchivoSiExiste(file, backupFile);
    }

    fs.writeFileSync(tempFile, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tempFile, file);
    return true;
  } catch (e) {
    console.log(`Error guardando ${file}:`, e.message);

    try {
      if (existeArchivoSeguro(tempFile)) fs.unlinkSync(tempFile);
    } catch {}

    return false;
  }
}

function leerJSONSeguro(file, backupFile, fallback, opciones = {}) {
  const { protegerContraVacio = false } = opciones;

  if (!existeArchivoSeguro(file)) {
    guardarJSONSeguro(file, backupFile, fallback);
    return fallback;
  }

  try {
    const raw = fs.readFileSync(file, 'utf8');

    if (protegerContraVacio && (!raw || !raw.trim())) {
      throw new Error('Archivo vacío');
    }

    const parsed = JSON.parse(raw);

    if (
      protegerContraVacio &&
      (
        parsed === null ||
        typeof parsed !== 'object' ||
        Array.isArray(parsed)
      )
    ) {
      throw new Error('JSON inválido para objeto principal');
    }

    return parsed;
  } catch (e) {
    console.log(`Error leyendo ${file}:`, e.message);
  }

  if (existeArchivoSeguro(backupFile)) {
    try {
      const rawBackup = fs.readFileSync(backupFile, 'utf8');

      if (protegerContraVacio && (!rawBackup || !rawBackup.trim())) {
        throw new Error('Backup vacío');
      }

      const parsedBackup = JSON.parse(rawBackup);

      if (
        protegerContraVacio &&
        (
          parsedBackup === null ||
          typeof parsedBackup !== 'object' ||
          Array.isArray(parsedBackup)
        )
      ) {
        throw new Error('Backup inválido');
      }

      console.log(`Recuperado desde backup: ${backupFile}`);
      guardarJSONSeguro(file, backupFile, parsedBackup);
      return parsedBackup;
    } catch (e) {
      console.log(`Error leyendo backup ${backupFile}:`, e.message);
    }
  }

  return fallback;
}

function leerData() {
  return leerJSONSeguro(DATA_FILE, DATA_BACKUP_FILE, {}, { protegerContraVacio: true });
}

function leerState() {
  const state = leerJSONSeguro(
    STATE_FILE,
    STATE_BACKUP_FILE,
    {
      offset: 0,
      schedules: [],
      esperandoFoto: null,
      cola_reanudar: {
        activa: false,
        pendientes: [],
        ultimoPaso: null,
        intervaloMs: INTERVALO_REANUDAR_MS
      }
    },
    { protegerContraVacio: false }
  );

  if (!Array.isArray(state.schedules)) state.schedules = [];
  if (!('esperandoFoto' in state)) state.esperandoFoto = null;

  if (!state.cola_reanudar || typeof state.cola_reanudar !== 'object') {
    state.cola_reanudar = {
      activa: false,
      pendientes: [],
      ultimoPaso: null,
      intervaloMs: INTERVALO_REANUDAR_MS
    };
  }

  if (!Array.isArray(state.cola_reanudar.pendientes)) {
    state.cola_reanudar.pendientes = [];
  }

  if (!state.cola_reanudar.intervaloMs) {
    state.cola_reanudar.intervaloMs = INTERVALO_REANUDAR_MS;
  }

  return state;
}

function guardarData(data) {
  return guardarJSONSeguro(DATA_FILE, DATA_BACKUP_FILE, data);
}

function guardarState(state) {
  return guardarJSONSeguro(STATE_FILE, STATE_BACKUP_FILE, state);
}

function horaActual() {
  return new Date().toLocaleString();
}

function fechaHoy() {
  return new Date().toISOString().slice(0, 10);
}

function asegurarPerfil(data, id) {
  if (!data[id]) {
    data[id] = {
      nombre: `Perfil ${id}`,
      chat_id: '',
      telefono: '',
      codigo: '',
      ubicacion: '',
      texto: '',
      estado: 'ACTIVA',
      foto_modelo: 'https://picsum.photos/400/260',
      foto_pagina: 'https://picsum.photos/420/280',
      historial_fotos: [],
      ultima_hora: 'N/A',
      proximo_post: '16m',
      proximo_post_ts: null,
      fin_plan: '7 días',
      ultima_accion: 'Creado',
      ultimo_evento: null,
      bump_hoy: 0,
      bump_total: 0,
      bump_fecha: ''
    };
  } else {
    if (typeof data[id].bump_hoy !== 'number') data[id].bump_hoy = 0;
    if (typeof data[id].bump_total !== 'number') data[id].bump_total = 0;
    if (typeof data[id].bump_fecha !== 'string') data[id].bump_fecha = '';
    if (!('proximo_post_ts' in data[id])) data[id].proximo_post_ts = null;
    if (!Array.isArray(data[id].historial_fotos)) data[id].historial_fotos = [];
    if (!data[id].estado) data[id].estado = 'ACTIVA';
  }
}

function resetBumpSiCambioDia(perfil) {
  const hoy = fechaHoy();
  if (perfil.bump_fecha !== hoy) {
    perfil.bump_fecha = hoy;
    perfil.bump_hoy = 0;
  }
}

function tiempoRestante(ts) {
  if (!ts) return 'N/A';
  const faltan = Math.max(0, ts - Date.now());
  const totalSeg = Math.floor(faltan / 1000);
  const m = Math.floor(totalSeg / 60);
  const s = totalSeg % 60;
  return `${m}m ${s}s`;
}

function tiempoProximoPost(perfil) {
  return perfil.proximo_post_ts
    ? tiempoRestante(perfil.proximo_post_ts)
    : (perfil.proximo_post || 'N/A');
}

function tiempoRestantePlan(fechaFin) {
  if (!fechaFin) return 'N/A';

  const ahora = new Date();
  const fin = new Date(fechaFin);

  if (isNaN(fin.getTime())) return fechaFin;

  const diff = fin - ahora;

  if (diff <= 0) return '❌ Vencido';

  const dias = Math.floor(diff / (1000 * 60 * 60 * 24));
  const horas = Math.floor((diff / (1000 * 60 * 60)) % 24);
  const minutos = Math.floor((diff / (1000 * 60)) % 60);
  const segundos = Math.floor((diff / 1000) % 60);

  return `${dias} días, ${horas}h ${minutos}m ${segundos}s`;
}

function convertirFinPlan(valor) {
  if (!valor) return '';

  const texto = String(valor).trim().toLowerCase();

  if (/^\d{4}-\d{2}-\d{2}(t\d{2}:\d{2}:\d{2})?$/.test(texto)) {
    return valor;
  }

  const m = texto.match(/^(\d+)\s*d[ií]a?s?$/);
  if (m) {
    const dias = Number(m[1]);
    const fecha = new Date();
    fecha.setDate(fecha.getDate() + dias);
    fecha.setHours(23, 59, 59, 0);
    return fecha.toISOString().slice(0, 19);
  }

  return valor;
}

// =========================
// TELEGRAM
// =========================
function tecladoTelegram(id) {
  return {
    inline_keyboard: [
      [
        { text: '⏸ Pausar', callback_data: `pausar_${id}` },
        { text: '▶️ Reanudar', callback_data: `reanudar_${id}` }
      ],
      [
        { text: '⏸ Pausar todas', callback_data: 'pausar_todas' },
        { text: '▶️ Reanudar todas', callback_data: 'reanudar_todas' }
      ],
      [
        { text: '⏰ Programar pausa', callback_data: `progpausa_${id}` },
        { text: '⏰ Programar reanudar', callback_data: `progreanudar_${id}` }
      ],
      [
        { text: '🕒 Último bump', callback_data: `ultima_${id}` }
      ],
      [
        { text: '🔄 Reiniciar bot', callback_data: `reiniciar_${id}` }
      ],
      [
        { text: '📞 Contactar', url: SUPPORT_URL },
        { text: '📜 Ver reglas', callback_data: 'reglas' }
      ],
      [
        { text: '📸 Ver una foto', callback_data: `foto_${id}` }
      ],
      [
        { text: '📂 Ver últimas 3', callback_data: `fotos3_${id}` },
        { text: '🗂 Ver últimas 4', callback_data: `fotos4_${id}` }
      ]
    ]
  };
}

async function apiTelegram(method, payload) {
  try {
    const res = await axios.post(
      `https://api.telegram.org/bot${BOT_TOKEN}/${method}`,
      payload,
      { timeout: 30000 }
    );
    return res.data;
  } catch (error) {
    const msg = error.response?.data || error.message || '';

    if (
      String(msg).includes('ECONNRESET') ||
      String(msg).includes('ETIMEDOUT') ||
      String(msg).includes('socket hang up')
    ) {
      return null;
    }

    console.log(`Error Telegram ${method}:`);
    console.log(msg);
    return null;
  }
}

async function responderCallback(callbackQueryId, text = 'OK') {
  await apiTelegram('answerCallbackQuery', {
    callback_query_id: callbackQueryId,
    text
  });
}

async function enviarTexto(texto, chatId = CHAT_ID, idTeclado = null) {
  await apiTelegram('sendMessage', {
    chat_id: chatId,
    text: texto,
    reply_markup: idTeclado ? tecladoTelegram(idTeclado) : undefined
  });
}

async function enviarFoto(photo, caption, id) {
  const data = leerData();
  const perfil = data[id];
  const destino = perfil?.chat_id || CHAT_ID;

  const res = await apiTelegram('sendPhoto', {
    chat_id: destino,
    photo,
    caption,
    reply_markup: tecladoTelegram(id)
  });

  if (!res || !res.ok) {
    await apiTelegram('sendMessage', {
      chat_id: destino,
      text: caption,
      reply_markup: tecladoTelegram(id)
    });
  }
}

// =========================
// ESTADOS
// =========================
function cambiarEstadoPerfil(id, estado) {
  const data = leerData();
  if (!data[id]) return false;

  asegurarPerfil(data, id);
  data[id].estado = estado;
  data[id].ultima_hora = horaActual();
  data[id].ultima_accion = estado === 'ACTIVA' ? 'Reanudado' : 'Pausado';

  return guardarData(data);
}

function cambiarEstadoTodos(estado) {
  const data = leerData();
  for (const id of Object.keys(data)) {
    asegurarPerfil(data, id);
    data[id].estado = estado;
    data[id].ultima_hora = horaActual();
    data[id].ultima_accion =
      estado === 'ACTIVA' ? 'Reanudado globalmente' : 'Pausado globalmente';
  }
  guardarData(data);
}

function programarAccion(id, accion, minutos = 30) {
  const state = leerState();
  state.schedules.push({
    id,
    accion,
    ejecutarEn: Date.now() + minutos * 60 * 1000
  });
  guardarState(state);
}

// =========================
// REANUDAR TODAS EN COLA CADA 45 SEGUNDOS
// =========================
function ordenarIdsPerfiles(ids) {
  return ids.sort((a, b) => {
    const na = Number(a);
    const nb = Number(b);

    if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;

    return String(a).localeCompare(String(b));
  });
}

function cancelarColaReanudar() {
  const state = leerState();

  state.cola_reanudar = {
    activa: false,
    pendientes: [],
    ultimoPaso: null,
    intervaloMs: INTERVALO_REANUDAR_MS
  };

  guardarState(state);
}

async function iniciarColaReanudarTodos(chatId = CHAT_ID) {
  const data = leerData();
  const ids = ordenarIdsPerfiles(Object.keys(data));

  if (ids.length === 0) {
    await enviarTexto('⚠️ No hay perfiles para reanudar.', chatId);
    return;
  }

  for (const id of ids) {
    asegurarPerfil(data, id);
    data[id].estado = 'PAUSADA';
    data[id].ultima_hora = horaActual();
    data[id].ultima_accion = 'En espera para reanudar en cola';
  }

  const primero = ids[0];

  data[primero].estado = 'ACTIVA';
  data[primero].ultima_hora = horaActual();
  data[primero].ultima_accion = 'Reanudado por cola';

  guardarData(data);

  const state = leerState();

  state.cola_reanudar = {
    activa: true,
    pendientes: ids.slice(1).map(String),
    ultimoPaso: Date.now(),
    intervaloMs: INTERVALO_REANUDAR_MS
  };

  guardarState(state);

  await enviarTexto(
    `▶️ Reanudar todas iniciado en cola\n\n✅ Perfil ${primero} ACTIVA\n⏳ Próximo perfil en 45 segundos\n📌 Pendientes: ${ids.length - 1}`,
    chatId
  );

  await enviarEstadoPerfil(primero);
}

async function revisarColaReanudar() {
  const state = leerState();
  const cola = state.cola_reanudar;

  if (!cola || !cola.activa) return;

  if (!Array.isArray(cola.pendientes) || cola.pendientes.length === 0) {
    cola.activa = false;
    cola.ultimoPaso = null;
    cola.pendientes = [];
    state.cola_reanudar = cola;
    guardarState(state);

    await enviarTexto('✅ Cola de reanudar terminada. Todos los perfiles fueron activados.');
    return;
  }

  const intervalo = cola.intervaloMs || INTERVALO_REANUDAR_MS;

  if (Date.now() - cola.ultimoPaso < intervalo) return;

  const siguiente = cola.pendientes.shift();

  const data = leerData();
  asegurarPerfil(data, siguiente);

  data[siguiente].estado = 'ACTIVA';
  data[siguiente].ultima_hora = horaActual();
  data[siguiente].ultima_accion = 'Reanudado por cola cada 45 segundos';

  guardarData(data);

  cola.ultimoPaso = Date.now();

  if (cola.pendientes.length === 0) {
    cola.activa = false;
  }

  state.cola_reanudar = cola;
  guardarState(state);

  await enviarTexto(
    `▶️ Perfil ${siguiente} reanudado por cola\n⏳ Pendientes: ${cola.pendientes.length}`
  );

  await enviarEstadoPerfil(siguiente);
}

// =========================
// MENSAJES
// =========================
async function enviarEstadoPerfil(id) {
  const data = leerData();
  const perfil = data[id];
  if (!perfil) return;

  const caption = `🔥 jean carlos BOT 🔥

Perfil: ${perfil.nombre}
📞 Teléfono: ${perfil.telefono}
🆔 Código: ${perfil.codigo}
📍 Ubicación: ${perfil.ubicacion}
🟢 Estado: ${perfil.estado}
🕒 Hora: ${perfil.ultima_hora}
⏱ Próximo bump: ${tiempoProximoPost(perfil)}
📅 Tiempo para acabar plan: ${tiempoRestantePlan(perfil.fin_plan)}
📊 Bump hoy: ${perfil.bump_hoy || 0}
📈 Bump total: ${perfil.bump_total || 0}`;

  await enviarFoto(perfil.foto_modelo, caption, id);
}

async function enviarUltimaActualizacion(id) {
  const data = leerData();
  const perfil = data[id];
  if (!perfil) return;

  const caption = `🔥 ÚLTIMO BUMP
🐺 Los lobos del sistema te desean mucho éxito
💰 Que esta publicación te genere mucho dinero
🚀 Y que la próxima te deje aún más ganancias
📄 Información:

📞 Número: ${perfil.telefono}
🆔 Código: ${perfil.codigo}
📍 Ubicación: ${perfil.ubicacion}
📝 Texto: ${perfil.texto || 'N/A'}
🟢 Estado: ${perfil.estado}
🕒 Hora del bump: ${perfil.ultima_hora}
⏱ Tiempo para próximo bump: ${tiempoProximoPost(perfil)}
📅 Tiempo para acabar plan: ${tiempoRestantePlan(perfil.fin_plan)}

📊 Bump hoy: ${perfil.bump_hoy || 0}
📈 Bump total: ${perfil.bump_total || 0}`;

  await enviarFoto(perfil.foto_modelo, caption, id);
}

async function enviarFotoPagina(id) {
  const data = leerData();
  const perfil = data[id];
  if (!perfil) return;

  const caption = `📸 Foto guardada

📞 Número: ${perfil.telefono}
🆔 Código: ${perfil.codigo}`;

  await enviarFoto(perfil.foto_pagina, caption, id);
}

async function enviarUltimasFotos(id, cantidad) {
  const data = leerData();
  const perfil = data[id];
  if (!perfil) return;

  const fotos = Array.isArray(perfil.historial_fotos) ? perfil.historial_fotos : [];

  if (fotos.length === 0) {
    await enviarTexto(`⚠️ No hay fotos guardadas para el perfil ${id}`);
    return;
  }

  const lista = fotos.slice(0, cantidad);

  for (let i = 0; i < lista.length; i++) {
    await enviarFoto(lista[i], `📂 Foto ${i + 1} de ${lista.length}`, id);
  }
}

async function enviarReglas(chatId = CHAT_ID) {
  await enviarTexto(RULES_TEXT, chatId);
}

// =========================
// API LOCAL
// =========================
app.get('/api/estado/:id', (req, res) => {
  try {
    const data = leerData();
    const perfil = data[req.params.id];

    if (perfil && perfil.estado === 'PAUSADA') {
      return res.json({
        estado: 'PAUSADA',
        motivo: 'Pausada por orden explícita del panel'
      });
    }

    return res.json({
      estado: 'ACTIVA',
      motivo: 'Modo seguro: solo se pausa por orden explícita'
    });
  } catch (error) {
    console.log('Error en /api/estado/:id =>', error?.message || error);

    return res.json({
      estado: 'ACTIVA',
      motivo: 'Fallo del panel/lectura: se mantiene ACTIVA'
    });
  }
});

app.post('/registrar-evento', async (req, res) => {
  const {
    id,
    tipo = 'evento',
    telefono,
    codigo,
    ubicacion,
    texto,
    estado,
    foto_modelo,
    foto_pagina,
    fin_plan,
    ultima_accion,
    ultima_hora,
    minutos_siguientes = 16
  } = req.body;

  if (!id) {
    return res.status(400).json({ ok: false, error: 'Falta id' });
  }

  const data = leerData();
  asegurarPerfil(data, id);

  const perfil = data[id];

  if (telefono) perfil.telefono = telefono;
  if (codigo) perfil.codigo = codigo;
  if (ubicacion) perfil.ubicacion = ubicacion;
  if (typeof texto === 'string') perfil.texto = texto;
  if (estado) perfil.estado = estado;
  if (foto_modelo) perfil.foto_modelo = foto_modelo;
  if (foto_pagina) perfil.foto_pagina = foto_pagina;
  if (fin_plan) perfil.fin_plan = convertirFinPlan(fin_plan);

  perfil.ultima_hora = ultima_hora || horaActual();
  perfil.ultima_accion = ultima_accion || tipo;
  perfil.ultimo_evento = { tipo, hora: perfil.ultima_hora };

  if (tipo === 'publicado' || tipo === 'evento') {
    resetBumpSiCambioDia(perfil);
    perfil.bump_hoy = (perfil.bump_hoy || 0) + 1;
    perfil.bump_total = (perfil.bump_total || 0) + 1;
    perfil.bump_fecha = fechaHoy();
    perfil.proximo_post_ts = Date.now() + Number(minutos_siguientes) * 60 * 1000;
    perfil.proximo_post = tiempoProximoPost(perfil);
  }

  const ok = guardarData(data);

  if (!ok) {
    return res.status(500).json({ ok: false, error: 'No se pudo guardar data.json' });
  }

  await enviarUltimaActualizacion(id);

  res.json({ ok: true, perfil: data[id] });
});

// =========================
// TELEGRAM CALLBACKS
// =========================
async function procesarCallback(q) {
  const data = q.data || '';
  const callbackId = q.id;
  const chatId = q.message?.chat?.id || CHAT_ID;

  if (data === 'pausar_todas') {
    cancelarColaReanudar();
    cambiarEstadoTodos('PAUSADA');
    await responderCallback(callbackId, 'Todas pausadas');
    await enviarTexto('⏸ Todas las páginas quedaron en PAUSADA. Cola cancelada.', chatId);
    return;
  }

  if (data === 'reanudar_todas') {
    await responderCallback(callbackId, 'Cola iniciada');
    await iniciarColaReanudarTodos(chatId);
    return;
  }

  if (data === 'reglas') {
    await responderCallback(callbackId, 'Reglas');
    await enviarReglas(chatId);
    return;
  }

  const [accion, id] = data.split('_');
  if (!id) {
    await responderCallback(callbackId, 'Acción inválida');
    return;
  }

  if (accion === 'pausar') {
    cambiarEstadoPerfil(id, 'PAUSADA');
    await responderCallback(callbackId, 'Perfil pausado');
    await enviarEstadoPerfil(id);
    return;
  }

  if (accion === 'reanudar') {
    cambiarEstadoPerfil(id, 'ACTIVA');
    await responderCallback(callbackId, 'Perfil reanudado');
    await enviarEstadoPerfil(id);
    return;
  }

  if (accion === 'progpausa') {
    programarAccion(id, 'PAUSADA', 30);
    await responderCallback(callbackId, 'Pausa programada');
    await enviarTexto(`⏰ Se programó una pausa para el perfil ${id} en 30 minutos.`, chatId);
    return;
  }

  if (accion === 'progreanudar') {
    programarAccion(id, 'ACTIVA', 30);
    await responderCallback(callbackId, 'Reanudación programada');
    await enviarTexto(`⏰ Se programó una reanudación para el perfil ${id} en 30 minutos.`, chatId);
    return;
  }

  if (accion === 'ultima') {
    await responderCallback(callbackId, 'Último bump');
    await enviarUltimaActualizacion(id);
    return;
  }

  if (accion === 'foto') {
    await responderCallback(callbackId, 'Foto enviada');
    await enviarFotoPagina(id);
    return;
  }

  if (accion === 'reiniciar') {
    const ok = cambiarEstadoPerfil(id, 'ACTIVA');
    await responderCallback(callbackId, ok ? 'Bot reiniciado' : 'No encontrado');
    if (ok) {
      await enviarTexto(`🔄 Perfil ${id} reiniciado y puesto en ACTIVA.`, chatId);
      await enviarEstadoPerfil(id);
    }
    return;
  }

  if (accion === 'fotos3') {
    await responderCallback(callbackId, 'Enviando 3 fotos...');
    await enviarUltimasFotos(id, 3);
    return;
  }

  if (accion === 'fotos4') {
    await responderCallback(callbackId, 'Enviando 4 fotos...');
    await enviarUltimasFotos(id, 4);
    return;
  }

  await responderCallback(callbackId, 'No manejado');
}

async function revisarTelegram() {
  if (telegramEnProceso) return;
  telegramEnProceso = true;

  try {
    const state = leerState();

    const updates = await apiTelegram('getUpdates', {
      offset: state.offset + 1,
      timeout: 10
    });

    if (!updates || !updates.ok || !Array.isArray(updates.result)) {
      return;
    }

    for (const u of updates.result) {
      state.offset = u.update_id;

      if (u.callback_query) {
        await procesarCallback(u.callback_query);
      }

      if (u.message) {
        const msg = u.message;
        const chatId = msg.chat?.id || CHAT_ID;

        if (msg.text) {
          const texto = msg.text.trim().toUpperCase();

          if (/^P\d+$/.test(texto)) {
            const id = texto.replace('P', '');
            const data = leerData();
            asegurarPerfil(data, id);
            guardarData(data);

            state.esperandoFoto = id;
            guardarState(state);

            await enviarTexto(`📸 Ahora envía la foto para el perfil ${id}`, chatId);
          }
        }

        if (msg.photo) {
          const id = state.esperandoFoto;

          if (!id) {
            await enviarTexto('⚠️ Primero escribe P + número. Ejemplo: P15', chatId);
            continue;
          }

          const data = leerData();
          asegurarPerfil(data, id);

          const fileId = msg.photo[msg.photo.length - 1].file_id;

          data[id].foto_modelo = fileId;
          data[id].foto_pagina = fileId;

          if (!Array.isArray(data[id].historial_fotos)) {
            data[id].historial_fotos = [];
          }

          data[id].historial_fotos.unshift(fileId);
          data[id].historial_fotos = data[id].historial_fotos.slice(0, 10);

          data[id].ultima_hora = horaActual();
          data[id].ultima_accion = 'Foto guardada desde Telegram';

          guardarData(data);

          state.esperandoFoto = null;
          guardarState(state);

          await enviarTexto(`✅ Foto guardada para perfil ${id}`, chatId);
          await enviarFotoPagina(id);
        }
      }
    }

    guardarState(state);
  } catch (error) {
    console.log('Error en revisarTelegram:', error?.message || error);
  } finally {
    telegramEnProceso = false;
  }
}

async function ejecutarProgramaciones() {
  const state = leerState();
  const pendientes = [];
  let cambio = false;

  for (const item of state.schedules) {
    if (Date.now() >= item.ejecutarEn) {
      cambio = true;
      cambiarEstadoPerfil(item.id, item.accion);
      await enviarTexto(
        `⏰ Programación ejecutada\nPerfil: ${item.id}\nNuevo estado: ${item.accion}`
      );
      await enviarEstadoPerfil(item.id);
    } else {
      pendientes.push(item);
    }
  }

  if (cambio) {
    state.schedules = pendientes;
    guardarState(state);
  }
}

// PANEL WEB, FORMULARIOS Y ACCIONES QUEDAN IGUAL QUE TU SERVER ORIGINAL

app.post('/accion-global', async (req, res) => {
  const { accion } = req.body;

  if (accion === 'pausar_todas') {
    cancelarColaReanudar();
    cambiarEstadoTodos('PAUSADA');
    await enviarTexto('⏸ Todas las páginas quedaron en PAUSADA. Cola cancelada.');
  } else if (accion === 'reanudar_todas') {
    await iniciarColaReanudarTodos();
  }

  res.redirect('/');
});

// =========================
// CICLO SEGURO
// =========================
async function cicloPrincipal() {
  if (cicloEnProceso) {
    setTimeout(cicloPrincipal, 3000);
    return;
  }

  cicloEnProceso = true;

  try {
    await revisarTelegram();
    await ejecutarProgramaciones();
    await revisarColaReanudar();
  } catch (error) {
    console.log('Error en cicloPrincipal:', error?.message || error);
  } finally {
    cicloEnProceso = false;
    setTimeout(cicloPrincipal, 3000);
  }
}

// =========================
// START
// =========================
app.listen(PORT, async () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);

  if (!existeArchivoSeguro(DATA_FILE)) {
    guardarData({});
  }

  if (!existeArchivoSeguro(STATE_FILE)) {
    guardarState({
      offset: 0,
      schedules: [],
      esperandoFoto: null,
      cola_reanudar: {
        activa: false,
        pendientes: [],
        ultimoPaso: null,
        intervaloMs: INTERVALO_REANUDAR_MS
      }
    });
  }

  await apiTelegram('deleteWebhook', {});
  cicloPrincipal();
});