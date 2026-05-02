// ==UserScript==
// @name         Motor + Panel PRO 3000 + AUTO DATOS CURRENT POST + MULTI FOTO AUTO
// @namespace    http://tampermonkey.net/
// @version      6.0
// @match        *://*.megapersonals.eu/*
// @match        *://megapersonals.eu/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  const PERFIL_ID = "2";

  const PANEL_LOCAL = "http://127.0.0.1:3000";
  const PANEL_NUBE = "https://panel-control-300-production.up.railway.app";

  async function fetchPanel(path, options = {}) {
    try {
      return await fetch(`${PANEL_LOCAL}${path}`, {
        ...options,
        cache: 'no-store'
      });
    } catch (e) {
      return await fetch(`${PANEL_NUBE}${path}`, {
        ...options,
        cache: 'no-store'
      });
    }
  }

  const CICLO_MINUTOS = 16;
  const DELAY_CONFIRMACION = 15;
  const DELAY_SEGUNDO_TOQUE = 10;

  const KEY_ESTADO = `estado_${PERFIL_ID}`;
  const KEY_FASE = `fase_${PERFIL_ID}`;
  const KEY_NEXT = `next_${PERFIL_ID}`;
  const KEY_DATOS = `datos_mega_${PERFIL_ID}`;

  let estadoLocal = localStorage.getItem(KEY_ESTADO) || 'PAUSADA';
  let lockoutReporte = false;
  let lockoutDatos = false;

  let fase = parseInt(localStorage.getItem(KEY_FASE), 10);
  let nextTime = parseInt(localStorage.getItem(KEY_NEXT), 10);

  if (Number.isNaN(fase)) fase = 0;

  if (!nextTime || Number.isNaN(nextTime)) {
    nextTime = Date.now() + (CICLO_MINUTOS * 60 * 1000);
    guardarMemoria(fase, nextTime);
  }

  function guardarEstado(estado) {
    estadoLocal = estado;
    localStorage.setItem(KEY_ESTADO, estado);
  }

  function guardarMemoria(f, t) {
    fase = f;
    nextTime = t;
    localStorage.setItem(KEY_FASE, String(f));
    localStorage.setItem(KEY_NEXT, String(t));
  }

  function limpiarTexto(v) {
    return String(v || '').replace(/\s+/g, ' ').trim();
  }

  function sacarLinea(texto, etiqueta) {
    const regex = new RegExp(`${etiqueta}\\s*:\\s*([^\\n\\r]+)`, 'i');
    const match = texto.match(regex);
    return match ? limpiarTexto(match[1]) : '';
  }

  function normalizarUrlImagen(src) {
    try {
      if (!src) return '';
      if (src.startsWith('data:')) return '';
      return new URL(src, window.location.href).href;
    } catch (e) {
      return '';
    }
  }

  function detectarFotosMega() {
  const fotos = [];
  const imgs = Array.from(document.querySelectorAll('img'));

  for (const img of imgs) {
    const src = normalizarUrlImagen(
      img.currentSrc ||
img.getAttribute('data-original') ||
''
    );

    if (!src) continue;

    const rect = img.getBoundingClientRect();
    const ancho = rect.width || img.naturalWidth || 0;
    const alto = rect.height || img.naturalHeight || 0;

    // Solo imÃ¡genes grandes reales
    if (ancho < 250 || alto < 250) continue;

    const proporcion = ancho / alto;

    // Fotos normales de anuncio
    if (proporcion > 1.7 || proporcion < 0.5) continue;

    // Debe tener suficiente tamaÃ±o visual real
    const area = ancho * alto;
    if (area < 90000) continue;

    fotos.push({
      src,
      y: rect.top + window.scrollY,
      area
    });
  }

  fotos.sort((a, b) => {
    if (a.y !== b.y) return b.y - a.y;
    return b.area - a.area;
  });


  return [...new Set(fotos.map(f => f.src))].slice(0, 4);
}

  function leerDatosMega() {
    const textoPagina = document.body?.innerText || '';

    const telefono = sacarLinea(textoPagina, 'Phone');
    const city = sacarLinea(textoPagina, 'City');
    const location = sacarLinea(textoPagina, 'Location');
    const fotos = detectarFotosMega();

    let textoPost = '';
    const lineas = textoPagina.split('\n').map(limpiarTexto).filter(Boolean);
    const idxLocation = lineas.findIndex(l => /^Location\s*:/i.test(l));

    if (idxLocation >= 0) {
      textoPost = lineas
        .slice(idxLocation + 1, idxLocation + 10)
        .filter(l =>
          !/^Age\s*:/i.test(l) &&
          !/^Tokens/i.test(l) &&
          !/^CURRENT POST/i.test(l)
        )
        .join(' ')
        .slice(0, 1000);
    }

    return {
      telefono,
      ubicacion: limpiarTexto([city, location].filter(Boolean).join(' - ')),
      texto: limpiarTexto(textoPost),
      foto_pagina: fotos[0] || '',
      fotos_pagina: fotos
    };
  }

  async function sincronizarDatosMega() {
  if (lockoutDatos || !document.body) return;
  if (detectarExito()) return;

    const datos = leerDatosMega();

    if (
      !datos.telefono &&
      !datos.ubicacion &&
      !datos.texto &&
      !datos.foto_pagina &&
      (!datos.fotos_pagina || datos.fotos_pagina.length === 0)
    ) return;

    const firma = JSON.stringify(datos);
    const anterior = localStorage.getItem(KEY_DATOS);

    if (firma === anterior) return;

    lockoutDatos = true;
    localStorage.setItem(KEY_DATOS, firma);

    await registrarEventoEnPanel({
      id: PERFIL_ID,
      tipo: 'datos_actualizados',
      telefono: datos.telefono,
      ubicacion: datos.ubicacion,
      texto: datos.texto,
      foto_pagina: datos.foto_pagina,
      foto_modelo: datos.foto_pagina,
      fotos_pagina: datos.fotos_pagina,
      ultima_accion: 'Datos y fotos actualizados automÃÂ¡ticamente desde Mega',
      ultima_hora: new Date().toLocaleString()
    });

    setTimeout(() => {
      lockoutDatos = false;
    }, 30000);
  }

  async function consultarEstadoPerfil(id) {
    try {
      const res = await fetchPanel(`/api/estado/${id}?t=${Date.now()}`);
      const data = await res.json();

      if (data && data.estado) {
        guardarEstado(data.estado);
      }

      return estadoLocal;
    } catch (e) {
      console.log('Ã¢ÂÂ Ã¯Â¸Â Error consultando panel, mantiene estado actual');
      return estadoLocal;
    }
  }

  async function cambiarEstadoEnPanel(id, accion) {
    try {
      await fetchPanel(`/accion`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, accion })
      });
    } catch (e) {
      console.log('Error cambiando estado en panel:', e);
    }
  }

  async function registrarEventoEnPanel(payload) {
    try {
      await fetchPanel(`/registrar-evento`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    } catch (e) {
      console.log('Error registrando evento en panel:', e);
    }
  }

  function renderBoton() {
    const idUI = `motor-panel-${PERFIL_ID}`;
    const faltan = Math.max(0, Math.round((nextTime - Date.now()) / 1000));
    const m = Math.floor(faltan / 60);
    const s = faltan % 60;

    let box = document.getElementById(idUI);

    if (!box) {
      box = document.createElement('div');
      box.id = idUI;
      box.style = `
        position:fixed;
        bottom:70px;
        right:15px;
        width:120px;
        height:38px;
        border-radius:18px;
        border:1px solid #777;
        z-index:999999;
        display:flex;
        align-items:center;
        justify-content:space-around;
        cursor:pointer;
        font-family:monospace;
        font-weight:bold;
        background:rgba(0,0,0,0.9);
      `;

      box.innerHTML = `
        <div id="led-${PERFIL_ID}" style="width:12px;height:12px;border-radius:50%;"></div>
        <span id="time-${PERFIL_ID}" style="color:#fff;">0:00</span>
      `;

      box.onpointerdown = async (e) => {
        e.preventDefault();
        e.stopPropagation();

        const accion = estadoLocal === 'ACTIVA' ? 'pausar' : 'reanudar';
        await cambiarEstadoEnPanel(PERFIL_ID, accion);

        guardarEstado(accion === 'pausar' ? 'PAUSADA' : 'ACTIVA');
        renderBoton();
      };

      document.body.appendChild(box);
    }

    const led = document.getElementById(`led-${PERFIL_ID}`);
    const time = document.getElementById(`time-${PERFIL_ID}`);

    const activa = estadoLocal === 'ACTIVA';

    led.style.background = activa ? '#0f0' : '#f00';
    led.style.boxShadow = activa ? '0 0 8px #0f0' : '0 0 8px #f00';

    time.textContent = activa
      ? `${m}:${s < 10 ? '0' : ''}${s}`
      : 'OFF';
  }

  function detectarExito() {
    const txt = (document.body?.innerText || '').toLowerCase();
    const url = window.location.href.toLowerCase();

    return (
      url.includes('success_publish') ||
      txt.includes('sweet!') ||
      txt.includes('your post has been published')
    );
  }

  function ejecutarPasoPrincipal() {
    const btn = document.querySelector('#managePublishAd');

    console.log('btn existe:', !!btn);

    if (btn) {
      btn.click();
      console.log('Ã°ÂÂÂ¥ BUMP CLICK REAL');
      return true;
    }

    return false;
  }

  function buscarBotonMyPosts() {
    const botones = Array.from(document.querySelectorAll('a, button, input[type="button"], input[type="submit"]'));

    for (const el of botones) {
      const texto = (
        el.innerText ||
        el.value ||
        el.textContent ||
        ''
      ).trim().toLowerCase();

      if (texto.includes('my posts')) {
        return el;
      }
    }

    return null;
  }

  function ejecutarPasoConfirmacion() {
    const enExito = detectarExito();
    if (!enExito) return false;

    console.log('Ã°ÂÂÂ¢ FASE 2 Ã¢ÂÂ intentando segundo toque real');

    const btnMyPosts = buscarBotonMyPosts();

    if (btnMyPosts) {
      btnMyPosts.click();
      console.log('Ã¢ÂÂ Segundo toque en MY POSTS');
      return true;
    }

    if (window.history.length > 1) {
      try {
        window.history.back();
        console.log('Ã¢ÂÂ Segundo toque usando history.back()');
        return true;
      } catch (e) {
        console.log('Ã¢ÂÂ Ã¯Â¸Â FallÃÂ³ history.back()');
      }
    }

    console.log('Ã¢ÂÂ No se pudo hacer segundo toque');
    return false;
  }

  async function motor() {
    await sincronizarDatosMega();

    const estado = await consultarEstadoPerfil(PERFIL_ID);

    if (estado !== 'ACTIVA') {
      guardarMemoria(0, Date.now() + (CICLO_MINUTOS * 60 * 1000));
      renderBoton();
      return;
    }

    const ahora = Date.now();

    if (detectarExito() && !lockoutReporte) {
      lockoutReporte = true;

      await registrarEventoEnPanel({
        id: PERFIL_ID,
        tipo: 'publicado',
        ultima_accion: 'Publicado con ÃÂ©xito',
        ultima_hora: new Date().toLocaleString()
      });

      setTimeout(() => {
        lockoutReporte = false;
      }, 40000);
    }

    if (ahora < nextTime) {
      renderBoton();
      return;
    }

    if (fase === 0) {
      console.log('Ã°ÂÂÂ¥ FASE 0 Ã¢ÂÂ intentando BUMP');

      const ok = ejecutarPasoPrincipal();

      if (ok) {
        console.log('Ã¢ÂÂ BUMP OK Ã¢ÂÂ pasa a 15s');
        guardarMemoria(1, Date.now() + (DELAY_CONFIRMACION * 1000));
      } else {
        console.log('Ã¢ÂÂ FALLÃÂ Ã¢ÂÂ REINTENTO 1s');
        guardarMemoria(0, Date.now() + 1000);
      }

      renderBoton();
      return;
    }

    if (fase === 1) {
      if (detectarExito()) {
        console.log(`Ã°ÂÂÂ Pantalla rosada detectada Ã¢ÂÂ esperando ${DELAY_SEGUNDO_TOQUE}s antes del segundo toque`);
        guardarMemoria(2, Date.now() + (DELAY_SEGUNDO_TOQUE * 1000));
      } else {
        console.log('Ã¢ÂÂ³ FASE 1 esperando pantalla de ÃÂ©xito Ã¢ÂÂ reintenta en 1s');
        guardarMemoria(1, Date.now() + 1000);
      }

      renderBoton();
      return;
    }

    if (fase === 2) {
      const ok = ejecutarPasoConfirmacion();

      if (ok) {
        console.log('Ã¢ÂÂ SEGUNDO TOQUE OK Ã¢ÂÂ vuelve a 16 min');
        guardarMemoria(0, Date.now() + (CICLO_MINUTOS * 60 * 1000));
      } else {
        console.log('Ã¢ÂÂ³ FASE 2 no pudo hacer segundo toque Ã¢ÂÂ reintenta en 1s');
        guardarMemoria(2, Date.now() + 1000);
      }

      renderBoton();
      return;
    }
  }

  setInterval(() => {
    try {
      if (document.body) {
        renderBoton();
        motor();
      }
    } catch (e) {
      console.log('Error:', e);
    }
  }, 1000);

})();