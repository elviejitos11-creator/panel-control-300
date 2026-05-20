const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

let FormData = null;

try {
  FormData = require('form-data');
} catch (e) {
  console.log('⚠️ Falta form-data. Corre: npm install form-data');
}

const app = express();
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, X-Cliente-Token");
  next();
});

const PORT = 3000;

// CAMBIA ESTAS 4 COSAS
const BOT_TOKEN = '8216481031:AAFuClYkvFOPZ7VSRvtkKA0dcvqSEEA5bws';
const CHAT_ID = '';
const SUPPORT_URL = 'https://wa.me/18097760519';
const RULES_TEXT = `📜 Reglas del sistema

1. Antes de comenzar a trabajar, revisa que cada perfil tenga su información correcta y actualizada.
2. Las fotos enviadas por el sistema son reales y actualizadas en vivo cuando llega la notificación.
3. Cada actualización debe revisarse con atención para mantener el trabajo limpio, organizado y seguro.
4. Si necesitas ayuda, por favor contacta soporte al +1 809 776 0519 o usa el botón Contactar.`;

// archivos locales
const DATA_FILE = path.join(__dirname, 'data.json');
const STATE_FILE = path.join(__dirname, 'bot_state.json');
const DATA_BACKUP_FILE = path.join(__dirname, 'data.backup.json');
const STATE_BACKUP_FILE = path.join(__dirname, 'bot_state.backup.json');

// programación separada para que NO se borre al abrir panel ni al tocar Telegram
const PROGRAMACIONES_FILE = path.join(__dirname, 'programaciones.json');
const PROGRAMACIONES_BACKUP_FILE = path.join(__dirname, 'programaciones.backup.json');

// =========================
// BLOQUEOS DE CICLO
// =========================
let telegramEnProceso = false;
let cicloEnProceso = false;

// =========================
// COLA DE REANUDACIÓN
// =========================
let colaReanudacion = null;
let colaTimeout = null;
let colaVersion = 0;

function cancelarColaReanudacion() {
  if (colaTimeout) {
    clearTimeout(colaTimeout);
    colaTimeout = null;
  }

  colaReanudacion = null;
  colaVersion += 1;
}

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
  return leerJSONSeguro(
    STATE_FILE,
    STATE_BACKUP_FILE,
    {
      offset: 0,
      schedules: [],
      esperandoFoto: null,
      esperandoProgramacion: null,
      ultimoMensajeProgramacion: null,
      alertas: [],
      ultima_alerta_general_ts: 0
    },
    { protegerContraVacio: false }
  );
}

function leerProgramaciones() {
  const data = leerJSONSeguro(
    PROGRAMACIONES_FILE,
    PROGRAMACIONES_BACKUP_FILE,
    { items: [] },
    { protegerContraVacio: false }
  );

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { items: [] };
  }

  if (!Array.isArray(data.items)) {
    data.items = [];
  }

  return data;
}

function guardarData(data) {
  return guardarJSONSeguro(DATA_FILE, DATA_BACKUP_FILE, data);
}

function guardarState(state) {
  return guardarJSONSeguro(STATE_FILE, STATE_BACKUP_FILE, state);
}

function guardarProgramaciones(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    data = { items: [] };
  }

  if (!Array.isArray(data.items)) {
    data.items = [];
  }

  return guardarJSONSeguro(PROGRAMACIONES_FILE, PROGRAMACIONES_BACKUP_FILE, data);
}

function guardarStateTelegramSeguro(stateParcial) {
  const actual = leerState();

  actual.offset = stateParcial.offset || actual.offset || 0;

  if ('esperandoFoto' in stateParcial) {
    actual.esperandoFoto = stateParcial.esperandoFoto;
  }

  if ('esperandoProgramacion' in stateParcial) {
    actual.esperandoProgramacion = stateParcial.esperandoProgramacion;
  }

  if ('ultimoMensajeProgramacion' in stateParcial) {
    actual.ultimoMensajeProgramacion = stateParcial.ultimoMensajeProgramacion;
  }

  if (!Array.isArray(actual.schedules)) actual.schedules = [];
  if (!Array.isArray(actual.alertas)) actual.alertas = [];
  if (!('ultima_alerta_general_ts' in actual)) actual.ultima_alerta_general_ts = 0;

  return guardarState(actual);
}

function horaActual() {
  return new Date().toLocaleString();
}

function fechaHoy() {
  return new Date().toISOString().slice(0, 10);
}

function generarTokenAcceso() {
  const parte1 = Math.floor(1000 + Math.random() * 9000);
  const parte2 = Math.random().toString(36).slice(2, 6).toUpperCase();
  const parte3 = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `${parte1}-${parte2}-${parte3}`;
}

function escaparHtml(valor) {
  return String(valor || '').replace(/[&<>"']/g, (c) => {
    if (c === '&') return '&amp;';
    if (c === '<') return '&lt;';
    if (c === '>') return '&gt;';
    if (c === '"') return '&quot;';
    if (c === "'") return '&#039;';
    return c;
  });
}

function asegurarPerfil(data, id) {
  if (!data[id]) {
    data[id] = {
      nombre: `Perfil ${id}`,
      chat_id: '',
      cliente_token: '',
      telefono: '',
      codigo: '',
      ubicacion: '',
      texto: '',
      estado: 'ACTIVA',
      foto_modelo: 'https://picsum.photos/400/260',
      foto_pagina: 'https://picsum.photos/420/280',
      foto_bump: '',
      historial_fotos: [],
      ultima_hora: 'N/A',
      proximo_post: '16m',
      proximo_post_ts: null,
      fin_plan: '7 días',
      ultima_accion: 'Creado',
      ultimo_evento: null,
      bump_hoy: 0,
      bump_total: 0,
      bump_fecha: '',
      ultima_alerta: '',
      ultima_alerta_tipo: '',
      ultima_alerta_hora: '',
      ultima_alerta_foto: '',
      historial_alertas: []
    };
  } else {
    if (typeof data[id].bump_hoy !== 'number') data[id].bump_hoy = 0;
    if (typeof data[id].bump_total !== 'number') data[id].bump_total = 0;
    if (typeof data[id].bump_fecha !== 'string') data[id].bump_fecha = '';
    if (!('proximo_post_ts' in data[id])) data[id].proximo_post_ts = null;
    if (!Array.isArray(data[id].historial_fotos)) data[id].historial_fotos = [];
    if (!data[id].estado) data[id].estado = 'ACTIVA';
    if (!('cliente_token' in data[id])) data[id].cliente_token = '';
    if (!('foto_bump' in data[id])) data[id].foto_bump = '';
    if (!('foto_modelo' in data[id])) data[id].foto_modelo = 'https://picsum.photos/400/260';
    if (!('foto_pagina' in data[id])) data[id].foto_pagina = 'https://picsum.photos/420/280';
    if (!('ultima_alerta' in data[id])) data[id].ultima_alerta = '';
    if (!('ultima_alerta_tipo' in data[id])) data[id].ultima_alerta_tipo = '';
    if (!('ultima_alerta_hora' in data[id])) data[id].ultima_alerta_hora = '';
    if (!('ultima_alerta_foto' in data[id])) data[id].ultima_alerta_foto = '';
    if (!Array.isArray(data[id].historial_alertas)) data[id].historial_alertas = [];
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

function planVencido(perfil) {
  if (!perfil || !perfil.fin_plan) return false;

  const fin = new Date(perfil.fin_plan);

  if (isNaN(fin.getTime())) return false;

  return fin <= new Date();
}

function puedeContarBump(perfil) {
  if (!perfil) return false;
  if (perfil.estado === 'PAUSADA') return false;
  if (planVencido(perfil)) return false;
  return true;
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

function tokenDesdeRequest(req) {
  return String(
    req.query?.token ||
    req.body?.token ||
    req.headers['x-cliente-token'] ||
    ''
  ).trim();
}

function tokenValidoParaPerfil(req, perfil) {
  const token = tokenDesdeRequest(req);

  if (!perfil.cliente_token) return true;

  return token === String(perfil.cliente_token).trim();
}

function limitarTexto(texto, max = 1200) {
  const t = String(texto || '').trim();
  return t.length > max ? t.slice(0, max) + '...' : t;
}

function limpiarTextoTelegram(valor) {
  let texto = String(valor || '');

  texto = texto
    .replace(/\s*\b\d+\s+Notices?\s+and\s+Messages?\b[\s\S]*$/gi, '')
    .replace(/\s*\bNotices?\s+and\s+Messages?\b[\s\S]*$/gi, '')
    .replace(/\s*\bREPORT\s+BUG\b[\s\S]*$/gi, '')
    .replace(/\s*\bDELETE\s+ACCOUNT\b[\s\S]*$/gi, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\s+$/g, '')
    .trim();

  return texto;
}

// =========================
// AISLAMIENTO POR GRUPO / CHAT ID
// =========================
function normalizarChatId(chatId) {
  return String(chatId || '').trim();
}

function idsPorChatId(chatId) {
  const data = leerData();
  const chat = normalizarChatId(chatId);

  if (!chat) {
    return Object.keys(data);
  }

  return Object.keys(data).filter(id => {
    asegurarPerfil(data, id);
    return normalizarChatId(data[id].chat_id) === chat;
  });
}

// =========================
// PROGRAMACIÓN POR HORA
// =========================

// Hora fija de República Dominicana. Así no depende de la hora rara de Railway.
const ZONA_RD_OFFSET_MS = -4 * 60 * 60 * 1000;

function pad2(n) {
  return String(n).padStart(2, '0');
}

function ahoraRDPartes() {
  const d = new Date(Date.now() + ZONA_RD_OFFSET_MS);

  return {
    ano: d.getUTCFullYear(),
    mes: d.getUTCMonth() + 1,
    dia: d.getUTCDate()
  };
}

function sumarDiasRD(partes, dias) {
  const d = new Date(Date.UTC(partes.ano, partes.mes - 1, partes.dia + dias, 12, 0, 0));

  return {
    ano: d.getUTCFullYear(),
    mes: d.getUTCMonth() + 1,
    dia: d.getUTCDate()
  };
}

function fechaRDATimestamp(ano, mes, dia, hora, minuto) {
  return Date.UTC(ano, mes - 1, dia, hora, minuto, 0, 0) - ZONA_RD_OFFSET_MS;
}

function formatearFechaRD(ts) {
  const d = new Date(Number(ts) + ZONA_RD_OFFSET_MS);

  const dia = pad2(d.getUTCDate());
  const mes = pad2(d.getUTCMonth() + 1);
  const ano = d.getUTCFullYear();

  const hora24 = d.getUTCHours();
  const minuto = pad2(d.getUTCMinutes());
  const ampm = hora24 >= 12 ? 'PM' : 'AM';
  const hora12 = hora24 % 12 || 12;

  return `${dia}/${mes}/${ano} ${pad2(hora12)}:${minuto} ${ampm}`;
}

function parsearHoraSimple(textoHora) {
  const texto = String(textoHora || '').trim().toUpperCase().replace(/\./g, '');
  const m = texto.match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?$/);

  if (!m) {
    return {
      ok: false,
      error: 'Hora inválida. Usa ejemplo: HOY 5:00 AM, MAÑANA 5:00 AM, o 09/05 5:00 AM'
    };
  }

  let hora = Number(m[1]);
  const minuto = m[2] ? Number(m[2]) : 0;
  const ampm = m[3] || '';

  if (Number.isNaN(hora) || Number.isNaN(minuto)) {
    return {
      ok: false,
      error: 'Hora inválida. Usa ejemplo: HOY 5:00 AM, MAÑANA 5:00 AM, o 09/05 5:00 AM'
    };
  }

  if (minuto < 0 || minuto > 59) {
    return {
      ok: false,
      error: 'Minuto inválido. Usa ejemplo: 5:30 AM'
    };
  }

  if (ampm) {
    if (hora < 1 || hora > 12) {
      return {
        ok: false,
        error: 'Hora inválida. Con AM/PM usa 1 a 12. Ejemplo: 5:00 AM'
      };
    }

    if (ampm === 'PM' && hora < 12) hora += 12;
    if (ampm === 'AM' && hora === 12) hora = 0;
  } else {
    if (hora < 0 || hora > 23) {
      return {
        ok: false,
        error: 'Hora inválida. Usa formato 24 horas, ejemplo: 17:00, o usa AM/PM'
      };
    }
  }

  return { ok: true, hora, minuto };
}

function fechaValidaRD(ano, mes, dia, hora, minuto) {
  const ts = fechaRDATimestamp(ano, mes, dia, hora, minuto);
  const d = new Date(ts + ZONA_RD_OFFSET_MS);

  return (
    d.getUTCFullYear() === ano &&
    d.getUTCMonth() + 1 === mes &&
    d.getUTCDate() === dia &&
    d.getUTCHours() === hora &&
    d.getUTCMinutes() === minuto
  );
}

function calcularHoraProgramada(textoHora) {
  const original = String(textoHora || '').trim();

  let texto = original
    .toUpperCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\./g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!texto) {
    return {
      ok: false,
      error: 'Debes escribir fecha y hora. Ejemplo: HOY 5:00 AM'
    };
  }

  const hoy = ahoraRDPartes();
  let fecha = hoy;
  let horaTexto = texto;

  if (texto.startsWith('HOY ')) {
    fecha = hoy;
    horaTexto = texto.replace(/^HOY\s+/, '').trim();
  } else if (texto.startsWith('MANANA ')) {
    fecha = sumarDiasRD(hoy, 1);
    horaTexto = texto.replace(/^MANANA\s+/, '').trim();
  } else {
    const mFecha = texto.match(/^(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?\s+(.+)$/);

    if (mFecha) {
      const dia = Number(mFecha[1]);
      const mes = Number(mFecha[2]);
      let ano = mFecha[3] ? Number(mFecha[3]) : hoy.ano;

      if (ano < 100) ano = 2000 + ano;

      fecha = { ano, mes, dia };
      horaTexto = mFecha[4].trim();
    } else {
      // Si solo escribes 5:00 AM, se intenta para HOY.
      // Si esa hora ya pasó, NO se manda para mañana: da error.
      fecha = hoy;
      horaTexto = texto;
    }
  }

  const hora = parsearHoraSimple(horaTexto);

  if (!hora.ok) {
    return hora;
  }

  if (!fechaValidaRD(fecha.ano, fecha.mes, fecha.dia, hora.hora, hora.minuto)) {
    return {
      ok: false,
      error: 'Fecha inválida. Usa formato DÍA/MES, ejemplo: 09/05 5:00 AM'
    };
  }

  const ejecutarEn = fechaRDATimestamp(fecha.ano, fecha.mes, fecha.dia, hora.hora, hora.minuto);

  if (ejecutarEn <= Date.now()) {
    return {
      ok: false,
      error: 'Esa hora ya pasó en República Dominicana. Escribe HOY si es hoy, MAÑANA si es mañana, o pon fecha: 09/05 5:00 AM'
    };
  }

  return {
    ok: true,
    ejecutarEn,
    fecha: formatearFechaRD(ejecutarEn)
  };
}

function obtenerProgramacionGlobal(accion, chatId = null) {
  const data = leerProgramaciones();
  const chat = normalizarChatId(chatId);

  const pendientes = data.items
    .filter(item => item && item.accion === accion)
    .filter(item => {
      const itemChat = normalizarChatId(item.chatId);
      return chat ? itemChat === chat : itemChat === '';
    })
    .filter(item => item.ejecutarEn && Date.now() < Number(item.ejecutarEn))
    .sort((a, b) => Number(a.ejecutarEn) - Number(b.ejecutarEn));

  return pendientes[0] || null;
}

function textoProgramacionActual(accion, chatId = null) {
  const item = obtenerProgramacionGlobal(accion, chatId);

  if (!item) {
    return 'No programado';
  }

  return `${item.horaTexto || 'N/A'}
Se ejecuta: ${formatearFechaRD(Number(item.ejecutarEn))}
Falta: ${tiempoRestante(Number(item.ejecutarEn))}`;
}

function resumenProgramacionesTelegram(chatId = null) {
  return `⏰ PROGRAMACIONES ACTUALES

⏸ Pausar todas:
${textoProgramacionActual('PAUSADA', chatId)}

▶️ Reanudar todas:
${textoProgramacionActual('ACTIVA', chatId)}`;
}

function mensajeProgramarTelegram(accion, chatId = null) {
  const titulo = accion === 'PAUSADA' ? '⏸ PAUSAR TODAS' : '▶️ REANUDAR TODAS';

  return `⏰ PROGRAMACIÓN

${titulo}

Estado actual:
${textoProgramacionActual(accion, chatId)}

Escribe fecha y hora.

Ejemplos:
HOY 5:00 AM
MAÑANA 5:00 AM
09/05 5:00 AM

Formato fecha:
DÍA/MES HORA

Para quitar esa programación, escribe:
CANCELAR`;
}

function programarAccionGlobal(accion, textoHora, chatId = null) {
  const resultadoHora = calcularHoraProgramada(textoHora);

  if (!resultadoHora.ok) {
    return {
      ok: false,
      error: resultadoHora.error
    };
  }

  const data = leerProgramaciones();
  const chat = normalizarChatId(chatId);

  data.items = data.items.filter(item => {
    return !(item.accion === accion && normalizarChatId(item.chatId) === chat);
  });

  data.items.push({
    id: 'TODAS',
    accion,
    chatId: chat,
    horaTexto: String(textoHora || '').trim(),
    ejecutarEn: resultadoHora.ejecutarEn
  });

  guardarProgramaciones(data);

  return {
    ok: true,
    ejecutarEn: resultadoHora.ejecutarEn,
    fecha: resultadoHora.fecha
  };
}

function cancelarProgramacionGlobal(accion, chatId = null) {
  const data = leerProgramaciones();
  const antes = data.items.length;
  const chat = normalizarChatId(chatId);

  data.items = data.items.filter(item => {
    return !(item.accion === accion && normalizarChatId(item.chatId) === chat);
  });

  guardarProgramaciones(data);

  return antes - data.items.length;
}

function htmlProgramacionesPendientes() {
  const data = leerProgramaciones();

  const pendientes = data.items
    .filter(item => item && item.ejecutarEn && Date.now() < Number(item.ejecutarEn))
    .sort((a, b) => Number(a.ejecutarEn) - Number(b.ejecutarEn));

  if (pendientes.length === 0) {
    return `
      <div class="programacionBox">
        <strong>⏰ Programaciones pendientes</strong>
        <div class="small">No hay programaciones guardadas ahora mismo.</div>
      </div>
    `;
  }

  const items = pendientes.map(item => {
    const accionTxt = item.accion === 'PAUSADA'
      ? '⏸ PAUSAR TODAS'
      : '▶️ REANUDAR TODAS';

    const fecha = formatearFechaRD(Number(item.ejecutarEn));
    const grupo = item.chatId ? `<div>Grupo Chat ID: ${escaparHtml(item.chatId)}</div>` : `<div>Grupo: GLOBAL ADMIN</div>`;

    return `
      <div class="programacionItem">
        <div><strong>${accionTxt}</strong></div>
        ${grupo}
        <div>Hora puesta: ${escaparHtml(item.horaTexto || 'N/A')}</div>
        <div>Se ejecuta: ${escaparHtml(fecha)}</div>
        <div>Falta: ${escaparHtml(tiempoRestante(Number(item.ejecutarEn)))}</div>
      </div>
    `;
  }).join('');

  return `
    <div class="programacionBox">
      <strong>⏰ Programaciones pendientes</strong>
      ${items}
    </div>
  `;
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
        { text: '🗂 Ver álbum completo', callback_data: `album_${id}` }
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

async function apiTelegramForm(method, form) {
  try {
    const headers = form.getHeaders ? form.getHeaders() : {};

    const res = await axios.post(
      `https://api.telegram.org/bot${BOT_TOKEN}/${method}`,
      form,
      {
        headers,
        timeout: 60000,
        maxBodyLength: Infinity,
        maxContentLength: Infinity
      }
    );

    return res.data;
  } catch (error) {
    console.log(`Error Telegram FORM ${method}:`);
    console.log(error.response?.data || error.message || error);
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
  return await apiTelegram('sendMessage', {
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

  return !!(res && res.ok);
}

function esImagenBase64(valor) {
  return typeof valor === 'string' && valor.startsWith('data:image/');
}

function bufferDesdeBase64(valor) {
  const limpio = String(valor || '').replace(/^data:image\/\w+;base64,/, '');
  return Buffer.from(limpio, 'base64');
}

async function enviarBufferComoFoto(buffer, caption, id, filename = 'imagen.jpg') {
  const data = leerData();
  const perfil = data[id];
  const destino = perfil?.chat_id || CHAT_ID;

  if (!FormData) {
    await enviarTexto('⚠️ Falta form-data. Corre: npm install form-data', destino, id);
    return false;
  }

  const form = new FormData();
  form.append('chat_id', String(destino));
  form.append('caption', caption);
  form.append('reply_markup', JSON.stringify(tecladoTelegram(id)));
  form.append('photo', buffer, {
    filename,
    contentType: 'image/jpeg'
  });

  const res = await apiTelegramForm('sendPhoto', form);

  if (res && res.ok) return true;

  await apiTelegram('sendMessage', {
    chat_id: destino,
    text: caption,
    reply_markup: tecladoTelegram(id)
  });

  return false;
}

async function enviarFotoFlexible(photo, caption, id) {
  if (esImagenBase64(photo)) {
    try {
      const buffer = bufferDesdeBase64(photo);
      return await enviarBufferComoFoto(buffer, caption, id, `foto_${id}.jpg`);
    } catch (e) {
      console.log('No se pudo enviar foto base64:', e.message);
      return false;
    }
  }

  return await enviarFoto(photo, caption, id);
}

// =========================
// ESTADOS
// =========================
function cambiarEstadoPerfil(id, estado) {
  const data = leerData();
  if (!data[id]) return false;

  asegurarPerfil(data, id);

  if (estado === 'PAUSADA' && Array.isArray(colaReanudacion)) {
    colaReanudacion = colaReanudacion.filter(x => String(x) !== String(id));
  }

  data[id].estado = estado;
  data[id].ultima_hora = horaActual();
  data[id].ultima_accion = estado === 'ACTIVA' ? 'Reanudado' : 'Pausado';

  return guardarData(data);
}

function cambiarEstadoTodos(estado, chatId = null) {
  if (estado === 'PAUSADA') {
    cancelarColaReanudacion();
  }

  const data = leerData();
  const ids = chatId ? idsPorChatId(chatId) : Object.keys(data);

  for (const id of ids) {
    asegurarPerfil(data, id);
    data[id].estado = estado;
    data[id].ultima_hora = horaActual();
    data[id].ultima_accion =
      estado === 'ACTIVA' ? 'Reanudado por grupo' : 'Pausado por grupo';
  }

  guardarData(data);
  return ids.length;
}

function limpiarAlertasPerfil(id) {
  const data = leerData();
  if (!data[id]) return false;

  asegurarPerfil(data, id);

  data[id].ultima_alerta = '';
  data[id].ultima_alerta_tipo = '';
  data[id].ultima_alerta_hora = '';
  data[id].ultima_alerta_foto = '';
  data[id].ultima_hora = horaActual();
  data[id].ultima_accion = 'Alerta limpiada desde panel';

  return guardarData(data);
}

function resetearAccesoPerfil(id) {
  const data = leerData();
  if (!data[id]) return null;

  asegurarPerfil(data, id);

  const nuevoToken = generarTokenAcceso();

  data[id].cliente_token = nuevoToken;
  data[id].estado = 'PAUSADA';

  // LIMPIEZA COMPLETA PARA CLIENTE NUEVO
  data[id].telefono = '';
  data[id].codigo = '';
  data[id].ubicacion = '';
  data[id].texto = '';

  // BORRAR FOTOS VIEJAS
  data[id].foto_modelo = 'https://picsum.photos/400/260';
  data[id].foto_pagina = 'https://picsum.photos/420/280';
  data[id].foto_bump = '';
  data[id].historial_fotos = [];

  // RESETEAR CONTADORES
  data[id].bump_hoy = 0;
  data[id].bump_total = 0;
  data[id].bump_fecha = '';
  data[id].proximo_post = '16m';
  data[id].proximo_post_ts = null;

  // LIMPIAR ALERTAS Y EVENTOS
  data[id].ultimo_evento = null;
  data[id].ultima_alerta = '';
  data[id].ultima_alerta_tipo = '';
  data[id].ultima_alerta_hora = '';
  data[id].ultima_alerta_foto = '';
  data[id].historial_alertas = [];

  data[id].ultima_hora = horaActual();
  data[id].ultima_accion = `Acceso reseteado y perfil limpiado. Nueva clave: ${nuevoToken}`;

  const ok = guardarData(data);

  if (!ok) return null;

  return nuevoToken;
}

function limpiarProgramacionesPerfil(id) {
  const state = leerState();

  if (!Array.isArray(state.schedules)) {
    state.schedules = [];
  }

  const antes = state.schedules.length;

  state.schedules = state.schedules.filter(item => {
    return String(item.id) !== String(id);
  });

  const borradas = antes - state.schedules.length;

  if (borradas > 0) {
    guardarState(state);
  }

  return borradas;
}

function borrarPerfil(id) {
  const data = leerData();

  if (!data[id]) return false;

  if (Array.isArray(colaReanudacion)) {
    colaReanudacion = colaReanudacion.filter(x => String(x) !== String(id));

    if (colaReanudacion.length === 0) {
      cancelarColaReanudacion();
    }
  }

  limpiarProgramacionesPerfil(id);

  delete data[id];

  return guardarData(data);
}

function programarAccion(id, accion, minutos = 30) {
  const state = leerState();

  if (!Array.isArray(state.schedules)) {
    state.schedules = [];
  }

  state.schedules.push({
    id,
    accion,
    ejecutarEn: Date.now() + minutos * 60 * 1000
  });

  guardarState(state);
}

// =========================
// ALERTAS / MODO GUARDIA
// =========================
async function avisarAlertaGeneral(id, tipo, motivo) {
  const state = leerState();

  if (!Array.isArray(state.alertas)) {
    state.alertas = [];
  }

  const ahora = Date.now();
  const ventana = 30 * 60 * 1000;

  state.alertas.push({
    id: String(id),
    tipo: String(tipo || 'alerta'),
    motivo: String(motivo || ''),
    ts: ahora
  });

  state.alertas = state.alertas.filter(a => ahora - Number(a.ts || 0) <= ventana);

  const perfilesUnicos = new Set(state.alertas.map(a => String(a.id))).size;

  if (
    perfilesUnicos >= 2 &&
    (!state.ultima_alerta_general_ts || ahora - Number(state.ultima_alerta_general_ts) > 15 * 60 * 1000)
  ) {
    state.ultima_alerta_general_ts = ahora;
    guardarState(state);

    await enviarTexto(`🚨 ALERTA GENERAL

Hay ${perfilesUnicos} perfiles con alertas en los últimos 30 minutos.

Último perfil: ${id}
Tipo: ${tipo}
Motivo: ${motivo}

Revisa el panel antes de seguir.`);
    return;
  }

  guardarState(state);
}

async function registrarAlertaPerfil(id, tipo, motivo, detalle, fotoAlerta) {
  const data = leerData();
  if (!data[id]) return false;

  asegurarPerfil(data, id);

  const perfil = data[id];
  const hora = horaActual();

  perfil.estado = 'PAUSADA';
  perfil.ultima_alerta = limitarTexto(motivo || 'Alerta detectada');
  perfil.ultima_alerta_tipo = limitarTexto(tipo || 'alerta', 100);
  perfil.ultima_alerta_hora = hora;
  perfil.ultima_alerta_foto = fotoAlerta || '';
  perfil.ultima_hora = hora;
  perfil.ultima_accion = `🚨 ALERTA: ${limitarTexto(motivo || tipo || 'Problema detectado', 200)}`;
  perfil.ultimo_evento = {
    tipo: 'alerta',
    alerta_tipo: tipo || 'alerta',
    motivo: motivo || '',
    detalle: detalle || '',
    hora
  };

  if (!Array.isArray(perfil.historial_alertas)) {
    perfil.historial_alertas = [];
  }

  perfil.historial_alertas.unshift({
    tipo: tipo || 'alerta',
    motivo: motivo || '',
    detalle: detalle || '',
    hora
  });

  perfil.historial_alertas = perfil.historial_alertas.slice(0, 20);

  const ok = guardarData(data);
  if (!ok) return false;

  const caption = `🚨 MODO GUARDIA ACTIVADO

Perfil: ${perfil.nombre || id}
ID: ${id}
Estado: PAUSADA

Tipo:
${tipo || 'alerta'}

Motivo:
${motivo || 'Problema detectado'}

Detalle:
${detalle || 'N/A'}

Hora:
${hora}

Acción:
El perfil fue pausado automáticamente para revisión.`;

  if (fotoAlerta) {
    await enviarFotoFlexible(fotoAlerta, caption, id);
  } else {
    const destino = perfil?.chat_id || CHAT_ID;
    await enviarTexto(caption, destino, id);
  }

  await avisarAlertaGeneral(id, tipo || 'alerta', motivo || 'Problema detectado');

  return true;
}

// =========================
// MENSAJES
// =========================
async function enviarEstadoPerfil(id) {
  const data = leerData();
  const perfil = data[id];
  if (!perfil) return;

  const alerta = perfil.ultima_alerta
    ? `\n🚨 Última alerta: ${perfil.ultima_alerta}\n🕒 Hora alerta: ${perfil.ultima_alerta_hora || 'N/A'}`
    : '';

  const caption = `🔥 jean calos BOT 🔥

Perfil: ${perfil.nombre}
📞 Teléfono: ${perfil.telefono}
🆔 Código: ${perfil.codigo}
📍 Ubicación: ${perfil.ubicacion}
🟢 Estado: ${perfil.estado}
🕒 Hora: ${perfil.ultima_hora}
⏱ Próximo bump: ${tiempoProximoPost(perfil)}
📅 Tiempo para acabar plan: ${tiempoRestantePlan(perfil.fin_plan)}
📊 Bump hoy: ${perfil.bump_hoy || 0}
📈 Bump total: ${perfil.bump_total || 0}${alerta}`;

  await enviarFoto(perfil.foto_modelo, caption, id);
}

async function enviarUltimaActualizacion(id) {
  const data = leerData();
  const perfil = data[id];
  if (!perfil) return;

  const textoLimpio = limpiarTextoTelegram(perfil.texto || 'N/A');

  const alerta = perfil.ultima_alerta
    ? `\n🚨 Última alerta: ${perfil.ultima_alerta}\n🕒 Hora alerta: ${perfil.ultima_alerta_hora || 'N/A'}`
    : '';

  const caption = `🔥 ÚLTIMO BUMP
🐺 Los lobos del sistema te desean mucho éxito
💰 Que esta publicación te genere mucho dinero
🚀 Y que la próxima te deje aún más ganancias
📄 Información:
📞 Número: ${perfil.telefono}
🆔 Código: ${perfil.codigo}
📍 Ubicación: ${perfil.ubicacion}
📝 Texto: ${textoLimpio || 'N/A'}
🟢 Estado: ${perfil.estado}
🕒 Hora del bump: ${perfil.ultima_hora}
⏱ Tiempo para próximo bump: ${tiempoProximoPost(perfil)}
📅 Tiempo para acabar plan: ${tiempoRestantePlan(perfil.fin_plan)}
📊 Bump hoy: ${perfil.bump_hoy || 0}
📈 Bump total: ${perfil.bump_total || 0}${alerta}`;

  if (perfil.foto_bump) {
    const ok = await enviarFotoFlexible(perfil.foto_bump, caption, id);
    if (ok) return;
  }

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

async function enviarAlbumCompleto(id) {
  const data = leerData();
  const perfil = data[id];
  if (!perfil) return;

  const destino = perfil?.chat_id || CHAT_ID;
  const fotos = Array.isArray(perfil.historial_fotos) ? perfil.historial_fotos : [];

  if (fotos.length === 0) {
    await enviarTexto(`⚠️ No hay fotos guardadas para el perfil ${id}`, destino, id);
    return;
  }

  const lista = fotos.filter(Boolean).slice(0, 10);

  if (lista.length === 1) {
    await enviarFoto(lista[0], `🗂 Álbum completo\nFoto 1 de 1`, id);
    return;
  }

  const media = lista.map((foto, index) => ({
    type: 'photo',
    media: foto,
    caption: index === 0 ? `🗂 Álbum completo\n${lista.length} fotos guardadas` : undefined
  }));

  const res = await apiTelegram('sendMediaGroup', {
    chat_id: destino,
    media
  });

  if (!res || !res.ok) {
    await enviarUltimasFotos(id, 10);
    return;
  }

  await enviarTexto('🗂 Álbum completo enviado.', destino, id);
}

async function enviarReglas(chatId = CHAT_ID) {
  await enviarTexto(RULES_TEXT, chatId);
}

// =========================
// API LOCAL
// =========================
app.get('/api/licencia/:id', (req, res) => {
  try {
    const id = req.params.id;
    const token = req.query.token || '';

    const data = leerData();
    const perfil = data[id];

    if (!perfil) {
      return res.json({
        ok: false,
        estado: 'NO_EXISTE',
        motivo: 'Perfil no existe'
      });
    }

    if (perfil.cliente_token && token !== perfil.cliente_token) {
      return res.json({
        ok: false,
        estado: 'TOKEN_INVALIDO',
        motivo: 'Token inválido'
      });
    }

    if (perfil.estado === 'PAUSADA') {
      return res.json({
        ok: false,
        estado: 'PAUSADA',
        motivo: perfil.ultima_alerta ? `Pausado por alerta: ${perfil.ultima_alerta}` : 'Cliente pausado desde el panel'
      });
    }

    if (planVencido(perfil)) {
      return res.json({
        ok: false,
        estado: 'VENCIDA',
        motivo: 'Plan vencido'
      });
    }

    return res.json({
      ok: true,
      estado: 'ACTIVA',
      motivo: 'Licencia activa'
    });
  } catch (error) {
    console.log('Error en /api/licencia/:id =>', error?.message || error);

    return res.json({
      ok: false,
      estado: 'ERROR',
      motivo: 'Error verificando licencia'
    });
  }
});

app.get('/api/estado/:id', (req, res) => {
  try {
    const data = leerData();
    const perfil = data[req.params.id];

    if (!perfil) {
      return res.json({
        estado: 'NO_EXISTE',
        motivo: 'Perfil no existe'
      });
    }

    if (perfil.estado === 'PAUSADA') {
      return res.json({
        estado: 'PAUSADA',
        motivo: perfil.ultima_alerta ? `Pausada por alerta: ${perfil.ultima_alerta}` : 'Pausada por orden explícita del panel'
      });
    }

    return res.json({
      estado: 'ACTIVA',
      motivo: 'Modo seguro: solo se pausa por orden explícita'
    });
  } catch (error) {
    console.log('Error en /api/estado/:id =>', error?.message || error);

    return res.json({
      estado: 'ERROR',
      motivo: 'Fallo del panel/lectura'
    });
  }
});

app.post('/registrar-alerta', async (req, res) => {
  try {
    const {
      id,
      tipo = 'alerta',
      motivo = 'Problema detectado',
      detalle = '',
      foto_alerta,
      foto_alerta_base64
    } = req.body;

    if (!id) {
      return res.status(400).json({ ok: false, error: 'Falta id' });
    }

    const data = leerData();
    const perfil = data[id];

    if (!perfil) {
      return res.status(404).json({ ok: false, estado: 'NO_EXISTE', error: 'Perfil no existe' });
    }

    asegurarPerfil(data, id);

    if (!tokenValidoParaPerfil(req, perfil)) {
      return res.status(403).json({
        ok: false,
        estado: 'TOKEN_INVALIDO',
        error: 'Token inválido para registrar alerta'
      });
    }

    const fotoAlerta = foto_alerta_base64 || foto_alerta || '';

    const ok = await registrarAlertaPerfil(
      id,
      String(tipo || 'alerta'),
      String(motivo || 'Problema detectado'),
      String(detalle || ''),
      fotoAlerta
    );

    if (!ok) {
      return res.status(500).json({ ok: false, error: 'No se pudo guardar alerta' });
    }

    return res.json({
      ok: true,
      estado: 'PAUSADA',
      mensaje: 'Alerta registrada y perfil pausado'
    });
  } catch (error) {
    console.log('Error en /registrar-alerta =>', error?.message || error);
    return res.status(500).json({ ok: false, error: 'Error registrando alerta' });
  }
});

app.post('/registrar-evento', async (req, res) => {
  const {
    id,
    tipo = 'silencioso',
    telefono,
    codigo,
    ubicacion,
    texto,
    foto_modelo,
    foto_pagina,
    foto_bump,
    foto_bump_base64,
    fotos_pagina,
    fin_plan,
    ultima_accion,
    ultima_hora,
    minutos_siguientes = 16
  } = req.body;

  if (!id) {
    return res.status(400).json({ ok: false, error: 'Falta id' });
  }

  const tipoNormal = String(tipo || 'silencioso').trim().toLowerCase();

  const data = leerData();
  asegurarPerfil(data, id);

  const perfil = data[id];

  if (!tokenValidoParaPerfil(req, perfil)) {
    return res.status(403).json({
      ok: false,
      estado: 'TOKEN_INVALIDO',
      error: 'Token inválido para registrar evento'
    });
  }

  if (telefono) perfil.telefono = telefono;
  if (codigo) perfil.codigo = codigo;
  if (ubicacion) perfil.ubicacion = ubicacion;
  if (typeof texto === 'string') perfil.texto = texto;

  // IMPORTANTE:
  // /registrar-evento NO puede cambiar estado.
  // Solo el panel/botones o /registrar-alerta pueden cambiar estado.

  if (foto_modelo) perfil.foto_modelo = foto_modelo;
  if (foto_pagina) perfil.foto_pagina = foto_pagina;

  const pruebaBump = foto_bump_base64 || foto_bump;
  if (pruebaBump && typeof pruebaBump === 'string') {
    perfil.foto_bump = pruebaBump;
  }

  if (Array.isArray(fotos_pagina)) {
    const fotosLimpias = fotos_pagina
      .filter(foto => foto && typeof foto === 'string')
      .slice(0, 10);

    if (fotosLimpias.length >= 3) {
      perfil.historial_fotos = fotosLimpias;
      perfil.foto_pagina = fotosLimpias[0] || perfil.foto_pagina;
      perfil.foto_modelo = fotosLimpias[0] || perfil.foto_modelo;
    } else if (
      fotosLimpias.length === 1 &&
      (!Array.isArray(perfil.historial_fotos) || perfil.historial_fotos.length === 0)
    ) {
      perfil.historial_fotos = fotosLimpias;
      perfil.foto_pagina = fotosLimpias[0];
      perfil.foto_modelo = fotosLimpias[0];
    }
  }

  if (fin_plan) perfil.fin_plan = convertirFinPlan(fin_plan);

  perfil.ultima_hora = ultima_hora || horaActual();
  perfil.ultima_accion = ultima_accion || tipoNormal;
  perfil.ultimo_evento = { tipo: tipoNormal, hora: perfil.ultima_hora };

  let contarBump = false;

  if (tipoNormal === 'publicado') {
    if (puedeContarBump(perfil)) {
      contarBump = true;

      resetBumpSiCambioDia(perfil);
      perfil.bump_hoy = (perfil.bump_hoy || 0) + 1;
      perfil.bump_total = (perfil.bump_total || 0) + 1;
      perfil.bump_fecha = fechaHoy();
      perfil.proximo_post_ts = Date.now() + Number(minutos_siguientes) * 60 * 1000;
      perfil.proximo_post = tiempoProximoPost(perfil);
      perfil.ultima_accion = ultima_accion || 'Publicado con éxito';
    } else {
      perfil.ultima_accion = `Publicado ignorado: perfil ${perfil.estado}${planVencido(perfil) ? ' / vencido' : ''}`;
      perfil.ultimo_evento = {
        tipo: 'publicado_ignorado',
        hora: perfil.ultima_hora,
        motivo: perfil.estado === 'PAUSADA' ? 'PAUSADA' : (planVencido(perfil) ? 'VENCIDA' : 'BLOQUEADO')
      };
    }
  }

  const ok = guardarData(data);

  if (!ok) {
    return res.status(500).json({ ok: false, error: 'No se pudo guardar data.json' });
  }

  if (contarBump) {
    await enviarUltimaActualizacion(id);
  }

  res.json({
    ok: true,
    tipo: tipoNormal,
    bump_contado: contarBump,
    perfil: data[id]
  });
});

// =========================
// TELEGRAM CALLBACKS
// =========================
async function procesarCallback(q) {
  const data = q.data || '';
  const callbackId = q.id;
  const chatId = q.message?.chat?.id || CHAT_ID;

  if (data === 'pausar_todas') {
    const total = cambiarEstadoTodos('PAUSADA', chatId);
    await responderCallback(callbackId, 'Grupo pausado');
    await enviarTexto(`⏸ Se pausaron ${total} perfiles de este grupo. Cola cancelada.`, chatId);
    return;
  }

  if (data === 'reanudar_todas') {
    const total = idsPorChatId(chatId).length;
    reanudarTodasEnCola(chatId);
    await responderCallback(callbackId, 'Reanudando grupo');
    await enviarTexto(`▶️ Reanudando ${total} perfiles de este grupo en cola cada 45 segundos.`, chatId);
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
    const state = leerState();
    state.esperandoProgramacion = {
      accion: 'PAUSADA',
      chatId,
      ts: Date.now()
    };
    guardarState(state);

    await responderCallback(callbackId, 'Programar pausa');
    await enviarTexto(mensajeProgramarTelegram('PAUSADA', chatId), chatId);
    return;
  }

  if (accion === 'progreanudar') {
    const state = leerState();
    state.esperandoProgramacion = {
      accion: 'ACTIVA',
      chatId,
      ts: Date.now()
    };
    guardarState(state);

    await responderCallback(callbackId, 'Programar reanudar');
    await enviarTexto(mensajeProgramarTelegram('ACTIVA', chatId), chatId);
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

  if (accion === 'album') {
    await responderCallback(callbackId, 'Enviando álbum completo...');
    await enviarAlbumCompleto(id);
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

        const nuevoState = leerState();
        Object.assign(state, nuevoState);
        state.offset = u.update_id;
      }

      if (u.message) {
        const msg = u.message;
        const chatId = msg.chat?.id || CHAT_ID;

        if (msg.text) {
          const textoOriginal = msg.text.trim();
          const texto = textoOriginal.toUpperCase();

          if (
            state.esperandoProgramacion &&
            normalizarChatId(state.esperandoProgramacion.chatId) === normalizarChatId(chatId)
          ) {
            const accionPendiente = state.esperandoProgramacion.accion;
            const chatProgramacion = state.esperandoProgramacion.chatId || chatId;

            if (
              texto === 'CANCELAR' ||
              texto === 'CANCEL' ||
              texto === 'QUITAR' ||
              texto === 'BORRAR'
            ) {
              const borradas = cancelarProgramacionGlobal(accionPendiente, chatProgramacion);

              const nuevoState = leerState();
              nuevoState.esperandoProgramacion = null;
              nuevoState.offset = u.update_id;
              guardarStateTelegramSeguro(nuevoState);

              const accionTexto = accionPendiente === 'PAUSADA' ? '⏸ PAUSAR TODAS' : '▶️ REANUDAR TODAS';

              await enviarTexto(
                `✅ PROGRAMACIÓN QUITADA

${accionTexto}

Borradas: ${borradas}

${resumenProgramacionesTelegram(chatProgramacion)}`,
                chatId
              );

              continue;
            }

            const resultado = programarAccionGlobal(accionPendiente, textoOriginal, chatProgramacion);

            const nuevoState = leerState();
            nuevoState.esperandoProgramacion = null;
            nuevoState.offset = u.update_id;
            guardarStateTelegramSeguro(nuevoState);

            if (!resultado.ok) {
              await enviarTexto(
                `⚠️ ${resultado.error}

${mensajeProgramarTelegram(accionPendiente, chatProgramacion)}`,
                chatId
              );
              continue;
            }

            const palabra = accionPendiente === 'PAUSADA' ? '⏸ PAUSAR TODAS' : '▶️ REANUDAR TODAS';

            await enviarTexto(
              `✅ PROGRAMACIÓN GUARDADA

${palabra}

Hora:
${textoOriginal}

Se ejecutará:
${resultado.fecha}

${resumenProgramacionesTelegram(chatProgramacion)}`,
              chatId
            );

            continue;
          }

          if (/^P\d+$/.test(texto)) {
            const id = texto.replace('P', '');
            const data = leerData();
            asegurarPerfil(data, id);
            guardarData(data);

            state.esperandoFoto = id;
            guardarStateTelegramSeguro(state);

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
          guardarStateTelegramSeguro(state);

          await enviarTexto(`✅ Foto guardada para perfil ${id}`, chatId);
          await enviarFotoPagina(id);
        }
      }
    }

    const stateActual = leerState();
    stateActual.offset = state.offset;
    guardarStateTelegramSeguro(stateActual);
  } catch (error) {
    console.log('Error en revisarTelegram:', error?.message || error);
  } finally {
    telegramEnProceso = false;
  }
}

async function ejecutarProgramaciones() {
  const state = leerState();

  if (!Array.isArray(state.schedules)) {
    state.schedules = [];
  }

  const pendientesViejas = [];
  let cambioViejo = false;

  for (const item of state.schedules) {
    if (Date.now() >= Number(item.ejecutarEn)) {
      cambioViejo = true;
      cambiarEstadoPerfil(item.id, item.accion);
      await enviarTexto(
        `⏰ Programación ejecutada\nPerfil: ${item.id}\nNuevo estado: ${item.accion}`
      );
      await enviarEstadoPerfil(item.id);
    } else {
      pendientesViejas.push(item);
    }
  }

  if (cambioViejo) {
    const stateActual = leerState();
    stateActual.schedules = pendientesViejas;
    guardarState(stateActual);
  }

  const dataProgramaciones = leerProgramaciones();
  const pendientes = [];
  let cambio = false;

  for (const item of dataProgramaciones.items) {
    if (Date.now() >= Number(item.ejecutarEn)) {
      cambio = true;

      const chatDestino = normalizarChatId(item.chatId) || CHAT_ID;

      if (item.accion === 'PAUSADA') {
        const total = cambiarEstadoTodos('PAUSADA', item.chatId || null);

        await enviarTexto(
          `⏰ Programación ejecutada

Acción: PAUSAR TODAS
Perfiles afectados: ${total}
Hora programada: ${item.horaTexto || 'N/A'}`,
          chatDestino
        );
      } else if (item.accion === 'ACTIVA') {
        const total = idsPorChatId(item.chatId || null).length;
        reanudarTodasEnCola(item.chatId || null);

        await enviarTexto(
          `⏰ Programación ejecutada

Acción: REANUDAR TODAS
Perfiles afectados: ${total}
Hora programada: ${item.horaTexto || 'N/A'}

Reanudando en cola cada 45 segundos.`,
          chatDestino
        );
      }
    } else {
      pendientes.push(item);
    }
  }

  if (cambio) {
    dataProgramaciones.items = pendientes;
    guardarProgramaciones(dataProgramaciones);
  }
}

// =========================
// PANEL WEB
// =========================
app.get('/', (req, res) => {
  const data = leerData();
  let html = `
  <html>
  <head>
    <meta charset="UTF-8" />
    <title>PANEL PRO</title>
    <style>
      body { background:#0b1c2c; color:white; font-family:Arial,sans-serif; margin:0; padding:20px; }
      h1, h2 { margin-top:0; }
      .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(320px,1fr)); gap:16px; }
      .card { background:#132f4c; padding:20px; border-radius:14px; }
      .row { margin:6px 0; }
      .estado { font-weight:bold; }
      .alertaBox { background:#5c1616; border:1px solid #ff6b6b; padding:10px; border-radius:10px; margin:10px 0; }
      .programacionBox { background:#10263d; border:1px solid #4f86c6; padding:14px; border-radius:14px; margin:14px 0 18px 0; }
      .programacionItem { background:#183a5c; padding:10px; border-radius:10px; margin-top:10px; }
      button, .btn {
        margin:6px 6px 0 0; padding:10px 14px; border:none; border-radius:10px;
        cursor:pointer; font-weight:bold; text-decoration:none; display:inline-block;
      }
      .danger { background:#c62828; color:white; }
      .success { background:#2e7d32; color:white; }
      .info { background:#1565c0; color:white; }
      .muted { background:#455a64; color:white; }
      .warning { background:#ef6c00; color:white; }
      .small { font-size:12px; opacity:.9; }
      input, textarea, select {
        width:100%; padding:10px; border-radius:8px; border:none; margin-top:4px; margin-bottom:12px;
      }
      label { font-weight:bold; }
      .form-box { max-width:700px; background:#132f4c; padding:20px; border-radius:14px; }
    </style>
  </head>
  <body>
    <h1>🔥 PANEL PRO 🔥</h1>
    <div style="margin-bottom:16px;">
      <button class="danger" onclick="accionGlobal('pausar_todas')">⏸ Pausar todas</button>
      <button class="success" onclick="accionGlobal('reanudar_todas')">▶️ Reanudar todas</button>
      <a class="btn warning" href="/nuevo">➕ Nuevo perfil</a>
    </div>

    ${htmlProgramacionesPendientes()}

    <div class="grid">
  `;

  for (const id of Object.keys(data)) {
    const p = data[id];
    const totalFotos = Array.isArray(p.historial_fotos) ? p.historial_fotos.length : 0;
    const alertaHtml = p.ultima_alerta
      ? `
        <div class="alertaBox">
          <div><strong>🚨 Última alerta</strong></div>
          <div>Tipo: ${p.ultima_alerta_tipo || 'N/A'}</div>
          <div>Motivo: ${p.ultima_alerta || 'N/A'}</div>
          <div>Hora: ${p.ultima_alerta_hora || 'N/A'}</div>
        </div>
      `
      : '';

    html += `
      <div class="card">
        <div class="row"><strong>${p.nombre}</strong></div>
        <div class="row">🆔 Perfil: ${id}</div>
        <div class="row">💬 Chat ID: ${p.chat_id || 'N/A'}</div>
        <div class="row">🔑 Cliente token: ${p.cliente_token || 'SIN CLAVE'}</div>
        <div class="row">📞 ${p.telefono || 'N/A'}</div>
        <div class="row">🆔 Código: ${p.codigo || 'N/A'}</div>
        <div class="row">📍 ${p.ubicacion || 'N/A'}</div>
        <div class="row estado">🟢 ${p.estado}</div>
        <div class="row">🕒 ${p.ultima_hora}</div>
        <div class="row">⏱ Próximo bump: ${p.proximo_post_ts ? tiempoRestante(p.proximo_post_ts) : (p.proximo_post || 'N/A')}</div>
        <div class="row">📅 ${tiempoRestantePlan(p.fin_plan)}</div>
        <div class="row">📊 Bump hoy: ${p.bump_hoy || 0}</div>
        <div class="row">📈 Bump total: ${p.bump_total || 0}</div>
        <div class="row">🖼 Historial fotos: ${totalFotos}</div>
        <div class="row small">Última acción: ${p.ultima_accion || 'N/A'}</div>

        ${alertaHtml}

        <button class="danger" onclick="accionPerfil('${id}','pausar')">⏸ Pausar</button>
        <button class="success" onclick="accionPerfil('${id}','reanudar')">▶️ Reanudar</button>
        <button class="warning" onclick="accionPerfil('${id}','resetacceso')">🔐 Resetear acceso</button>
        <button class="info" onclick="accionPerfil('${id}','limpiaralerta')">✅ Limpiar alerta</button>
        <button class="muted" onclick="accionPerfil('${id}','progpausa')">⏰ Programar pausa</button>
        <button class="muted" onclick="accionPerfil('${id}','progreanudar')">⏰ Programar reanudar</button>
        <button class="info" onclick="accionPerfil('${id}','ultima')">🕒 Último bump</button>
        <button class="info" onclick="accionPerfil('${id}','foto')">📸 Ver foto</button>
        <button class="muted" onclick="accionPerfil('${id}','reiniciar')">🔄 Reiniciar bot</button>
        <a class="btn warning" href="/editar/${id}">✏️ Editar</a>
        <button class="danger" onclick="accionPerfil('${id}','borrarperfil')">🗑️ Borrar perfil</button>
      </div>
    `;
  }

  html += `
    </div>
    <script>
      setInterval(() => {
        location.reload();
      }, 10000);

      async function accionPerfil(id, accion) {
        let hora = '';

        if (accion === 'resetacceso') {
          const ok = confirm('¿Seguro que quieres resetear este perfil? Se borrarán fotos, datos viejos, contadores, alertas y la clave vieja dejará de funcionar.');
          if (!ok) return;
        }

        if (accion === 'borrarperfil') {
          const ok = confirm('¿Seguro que quieres BORRAR este perfil completo? Esta acción no se puede deshacer.');
          if (!ok) return;

          const ok2 = confirm('Última confirmación: se borrará el perfil, fotos, datos, token y programaciones pendientes.');
          if (!ok2) return;
        }

        if (accion === 'progpausa') {
          hora = prompt('Escribe fecha y hora para PAUSAR TODAS DEL GRUPO DE ESTE PERFIL. Ejemplos: HOY 5:00 AM / MAÑANA 5:00 AM / 09/05 5:00 AM');
          if (!hora) return;
        }

        if (accion === 'progreanudar') {
          hora = prompt('Escribe fecha y hora para REANUDAR TODAS DEL GRUPO DE ESTE PERFIL. Ejemplos: HOY 8:00 AM / MAÑANA 8:00 AM / 09/05 8:00 AM');
          if (!hora) return;
        }

        await fetch('/accion', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, accion, hora })
        });
        location.reload();
      }

      async function accionGlobal(accion) {
        await fetch('/accion-global', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ accion })
        });
        location.reload();
      }
    </script>
  </body>
  </html>
  `;

  res.send(html);
});

// FORM NUEVO PERFIL
app.get('/nuevo', (req, res) => {
  res.send(`
  <html>
  <head>
    <meta charset="UTF-8" />
    <title>Nuevo perfil</title>
    <style>
      body { background:#0b1c2c; color:white; font-family:Arial,sans-serif; margin:0; padding:20px; }
      input, textarea, select { width:100%; padding:10px; border-radius:8px; border:none; margin-top:4px; margin-bottom:12px; }
      label { font-weight:bold; }
      .form-box { max-width:700px; background:#132f4c; padding:20px; border-radius:14px; }
      button, a { padding:10px 14px; border:none; border-radius:10px; text-decoration:none; display:inline-block; }
      .success { background:#2e7d32; color:white; }
      .muted { background:#455a64; color:white; }
    </style>
  </head>
  <body>
    <h1>➕ Nuevo perfil</h1>
    <div class="form-box">
      <form method="POST" action="/guardar-perfil">
        <label>ID del perfil</label>
        <input name="id" required />

        <label>Nombre</label>
        <input name="nombre" />

        <label>Chat ID</label>
        <input name="chat_id" />

        <label>Cliente token / Clave de acceso</label>
        <input name="cliente_token" />

        <label>Teléfono</label>
        <input name="telefono" />

        <label>Código</label>
        <input name="codigo" />

        <label>Ubicación</label>
        <input name="ubicacion" />

        <label>Texto</label>
        <textarea name="texto"></textarea>

        <label>Estado</label>
        <select name="estado">
          <option value="ACTIVA">ACTIVA</option>
          <option value="PAUSADA">PAUSADA</option>
        </select>

        <label>Foto modelo (URL o file_id)</label>
        <input name="foto_modelo" />

        <label>Foto página (URL o file_id)</label>
        <input name="foto_pagina" />

        <label>Próximo post</label>
        <input name="proximo_post" value="16m" />

        <label>Fin de plan</label>
        <input name="fin_plan" value="7 días" />

        <button class="success" type="submit">Guardar perfil</button>
        <a class="muted" href="/">Volver</a>
      </form>
    </div>
  </body>
  </html>
  `);
});

// FORM EDITAR PERFIL
app.get('/editar/:id', (req, res) => {
  const data = leerData();
  const id = req.params.id;

  if (!data[id]) {
    return res.status(404).send('Perfil no encontrado');
  }

  const p = data[id];

  res.send(`
  <html>
  <head>
    <meta charset="UTF-8" />
    <title>Editar perfil ${id}</title>
    <style>
      body { background:#0b1c2c; color:white; font-family:Arial,sans-serif; margin:0; padding:20px; }
      input, textarea, select { width:100%; padding:10px; border-radius:8px; border:none; margin-top:4px; margin-bottom:12px; }
      label { font-weight:bold; }
      .form-box { max-width:700px; background:#132f4c; padding:20px; border-radius:14px; }
      button, a { padding:10px 14px; border:none; border-radius:10px; text-decoration:none; display:inline-block; }
      .success { background:#2e7d32; color:white; }
      .muted { background:#455a64; color:white; }
    </style>
  </head>
  <body>
    <h1>✏️ Editar perfil ${id}</h1>
    <div class="form-box">
      <form method="POST" action="/guardar-perfil">
        <input type="hidden" name="id" value="${id}" />

        <label>Nombre</label>
        <input name="nombre" value="${p.nombre || ''}" />

        <label>Chat ID</label>
        <input name="chat_id" value="${p.chat_id || ''}" />

        <label>Cliente token / Clave de acceso</label>
        <input name="cliente_token" value="${p.cliente_token || ''}" />

        <label>Teléfono</label>
        <input name="telefono" value="${p.telefono || ''}" />

        <label>Código</label>
        <input name="codigo" value="${p.codigo || ''}" />

        <label>Ubicación</label>
        <input name="ubicacion" value="${p.ubicacion || ''}" />

        <label>Texto</label>
        <textarea name="texto">${p.texto || ''}</textarea>

        <label>Estado</label>
        <select name="estado">
          <option value="ACTIVA" ${p.estado === 'ACTIVA' ? 'selected' : ''}>ACTIVA</option>
          <option value="PAUSADA" ${p.estado === 'PAUSADA' ? 'selected' : ''}>PAUSADA</option>
        </select>

        <label>Foto modelo (URL o file_id)</label>
        <input name="foto_modelo" value="${p.foto_modelo || ''}" />

        <label>Foto página (URL o file_id)</label>
        <input name="foto_pagina" value="${p.foto_pagina || ''}" />

        <label>Próximo post</label>
        <input name="proximo_post" value="${p.proximo_post || ''}" />

        <label>Fin de plan</label>
        <input name="fin_plan" value="${p.fin_plan || ''}" />

        <button class="success" type="submit">Guardar cambios</button>
        <a class="muted" href="/">Volver</a>
      </form>
    </div>
  </body>
  </html>
  `);
});

// GUARDAR PERFIL
app.post('/guardar-perfil', (req, res) => {
  const {
    id,
    nombre,
    chat_id,
    cliente_token,
    telefono,
    codigo,
    ubicacion,
    texto,
    estado,
    foto_modelo,
    foto_pagina,
    proximo_post,
    fin_plan
  } = req.body;

  if (!id) {
    return res.status(400).send('Falta ID');
  }

  const data = leerData();
  asegurarPerfil(data, id);

  data[id].nombre = nombre || `Perfil ${id}`;
  data[id].chat_id = chat_id || '';
  data[id].cliente_token = cliente_token || '';
  data[id].telefono = telefono || '';
  data[id].codigo = codigo || '';
  data[id].ubicacion = ubicacion || '';
  data[id].texto = texto || '';
  data[id].estado = estado || 'ACTIVA';
  data[id].foto_modelo = foto_modelo || data[id].foto_modelo || 'https://picsum.photos/400/260';
  data[id].foto_pagina = foto_pagina || data[id].foto_pagina || 'https://picsum.photos/420/280';
  data[id].proximo_post = proximo_post || '16m';
  data[id].fin_plan = convertirFinPlan(fin_plan || '7 días');
  data[id].ultima_hora = horaActual();
  data[id].ultimaAccion = 'Perfil editado desde panel';
  data[id].ultima_accion = 'Perfil editado desde panel';

  const ok = guardarData(data);

  if (!ok) {
    return res.status(500).send('No se pudo guardar el perfil');
  }

  res.redirect('/');
});

// =========================
// ACCIONES PANEL
// =========================
app.post('/accion', async (req, res) => {
  const { id, accion, hora } = req.body;
  const data = leerData();

  if (!data[id]) {
    return res.status(404).send('Perfil no encontrado');
  }

  const chatGrupoPerfil = normalizarChatId(data[id].chat_id);

  if (accion === 'pausar') {
    cambiarEstadoPerfil(id, 'PAUSADA');
    await enviarEstadoPerfil(id);
  } else if (accion === 'reanudar') {
    cambiarEstadoPerfil(id, 'ACTIVA');
    await enviarEstadoPerfil(id);
  } else if (accion === 'resetacceso') {
    const nuevoToken = resetearAccesoPerfil(id);

    if (nuevoToken) {
      await enviarTexto(`🔐 Acceso reseteado y perfil limpiado\nPerfil: ${id}\nNueva clave: ${nuevoToken}\nEstado: PAUSADA`);
    }
  } else if (accion === 'limpiaralerta') {
    const ok = limpiarAlertasPerfil(id);

    if (ok) {
      await enviarTexto(`✅ Alerta limpiada\nPerfil: ${id}`);
    }
  } else if (accion === 'borrarperfil') {
    const ok = borrarPerfil(id);

    if (ok) {
      await enviarTexto(`🗑️ Perfil borrado correctamente\nPerfil eliminado: ${id}`);
    } else {
      await enviarTexto(`⚠️ No se pudo borrar el perfil ${id}`);
    }
  } else if (accion === 'progpausa') {
    const resultado = programarAccionGlobal('PAUSADA', hora, chatGrupoPerfil || null);

    if (resultado.ok) {
      await enviarTexto(
        `✅ Programado desde panel\nAcción: PAUSAR TODAS DEL GRUPO\nChat ID: ${chatGrupoPerfil || 'GLOBAL ADMIN'}\nHora: ${hora}\nSe ejecutará: ${resultado.fecha}`,
        chatGrupoPerfil || CHAT_ID
      );
    } else {
      await enviarTexto(`⚠️ No se pudo programar: ${resultado.error}`, chatGrupoPerfil || CHAT_ID);
    }
  } else if (accion === 'progreanudar') {
    const resultado = programarAccionGlobal('ACTIVA', hora, chatGrupoPerfil || null);

    if (resultado.ok) {
      await enviarTexto(
        `✅ Programado desde panel\nAcción: REANUDAR TODAS DEL GRUPO\nChat ID: ${chatGrupoPerfil || 'GLOBAL ADMIN'}\nHora: ${hora}\nSe ejecutará: ${resultado.fecha}`,
        chatGrupoPerfil || CHAT_ID
      );
    } else {
      await enviarTexto(`⚠️ No se pudo programar: ${resultado.error}`, chatGrupoPerfil || CHAT_ID);
    }
  } else if (accion === 'ultima') {
    await enviarUltimaActualizacion(id);
  } else if (accion === 'foto') {
    await enviarFotoPagina(id);
  } else if (accion === 'reiniciar') {
    cambiarEstadoPerfil(id, 'ACTIVA');
    await enviarTexto(`🔄 ${data[id].nombre} reiniciado.`);
    await enviarEstadoPerfil(id);
  }

  res.redirect('/');
});

app.post('/accion-global', async (req, res) => {
  const { accion } = req.body;

  // Estos dos botones de arriba del panel quedan como ADMIN GLOBAL.
  // Los botones de cada perfil y Telegram trabajan por Chat ID/grupo.
  if (accion === 'pausar_todas') {
    const total = cambiarEstadoTodos('PAUSADA');
    await enviarTexto(`⏸ Todas las páginas quedaron en PAUSADA. Total: ${total}. Cola cancelada.`);
  } else if (accion === 'reanudar_todas') {
    reanudarTodasEnCola();
    await enviarTexto('▶️ Reanudando todas en cola cada 45 segundos.');
  }

  res.redirect('/');
});

// =========================
// CICLO SEGURO
// =========================
async function procesarColaReanudacion(versionActiva) {
  if (versionActiva !== colaVersion) return;

  if (!colaReanudacion || colaReanudacion.length === 0) {
    cancelarColaReanudacion();
    return;
  }

  const id = colaReanudacion.shift();

  if (versionActiva !== colaVersion) return;

  cambiarEstadoPerfil(id, 'ACTIVA');

  const data = leerData();
  const perfil = data[id];
  const destino = perfil?.chat_id || CHAT_ID;

  await enviarTexto(`▶️ Perfil ${id} reanudado automáticamente en cola.`, destino);
  await enviarEstadoPerfil(id);

  if (versionActiva !== colaVersion) return;

  if (colaReanudacion && colaReanudacion.length > 0) {
    colaTimeout = setTimeout(() => {
      procesarColaReanudacion(versionActiva);
    }, 45000);
  } else {
    cancelarColaReanudacion();
  }
}

function reanudarTodasEnCola(chatId = null) {
  cancelarColaReanudacion();

  colaReanudacion = chatId ? idsPorChatId(chatId) : Object.keys(leerData());

  const versionActiva = colaVersion;

  if (colaReanudacion.length > 0) {
    procesarColaReanudacion(versionActiva);
  }
}

async function cicloPrincipal() {
  if (cicloEnProceso) {
    setTimeout(cicloPrincipal, 3000);
    return;
  }

  cicloEnProceso = true;

  try {
    await revisarTelegram();
    await ejecutarProgramaciones();
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
      esperandoProgramacion: null,
      ultimoMensajeProgramacion: null,
      alertas: [],
      ultima_alerta_general_ts: 0
    });
  }

  if (!existeArchivoSeguro(PROGRAMACIONES_FILE)) {
    guardarProgramaciones({ items: [] });
  }

  await apiTelegram('deleteWebhook', {});
  cicloPrincipal();
});