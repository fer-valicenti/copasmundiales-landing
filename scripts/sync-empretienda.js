const fs = require("fs");
const path = require("path");

const HTML_PATH = path.join(__dirname, "..", "index.html");
const STATE_PATH = path.join(__dirname, "empretienda-sync-state.json");

const URLS = {
  realSize: "https://copasmundiales.empretienda.com.ar/general/copa-del-mundo-tamano-real-version-pintada",
  mini: "https://copasmundiales.empretienda.com.ar/general/mini-copa-del-mundo-18-cm",
};

// Todos los productos de la tienda figuran en el sitemap (/<categoria>/<producto>). Si aparece uno que la
// landing no conoce, el control final falla para que se avise y se decida si se suma a la página.
const SITEMAP_URL = "https://copasmundiales.empretienda.com.ar/sitemap.xml";

const PRICE_RE = /\$[0-9]{1,3}(?:\.[0-9]{3})*,[0-9]{2}/g;
const STATS_RE = /(\d+)\s*años de experiencia y más de\s*(\d+)\s*entregas/;

// Mes de envío: Empretienda lo dice en la descripción de la copa tamaño real ("LA COMPRA SE ENVIA DURANTE
// EL MES DE NOVIEMBRE"). La landing lo repite en dos frases; si se reescriben, hay que cambiar estas
// expresiones también (el control final avisa si no las encuentra).
const MESES = "enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre";
const MES_ENVIO_RE = new RegExp(`LA COMPRA SE ENVIA DURANTE EL MES DE\\s+(${MESES})\\b`, "i");
const FRASES_MES_ENVIO = [
  { label: "Mes de envío (pregunta frecuente)", re: new RegExp(`(Los pedidos se despachan durante el mes de )(${MESES})(, en orden de reserva)`) },
  { label: "Mes de envío (cierre)", re: new RegExp(`(Los pedidos se envían durante )(${MESES})(, en orden de reserva)`) },
];

function formatThousands(n) {
  return Number(n).toLocaleString("es-AR");
}

async function fetchText(url) {
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (sync bot; copasmundiales-landing)" } });
  if (!res.ok) throw new Error(`Fetch falló (${res.status}) para ${url}`);
  return res.text();
}

async function main() {
  const state = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  let html = fs.readFileSync(HTML_PATH, "utf8");

  const [realHtml, miniHtml, sitemapXml] = await Promise.all([
    fetchText(URLS.realSize),
    fetchText(URLS.mini),
    fetchText(SITEMAP_URL).catch(() => null), // si falla, no frena los precios: queda en el control final
  ]);

  const realPrices = realHtml.match(PRICE_RE);
  const miniPrices = miniHtml.match(PRICE_RE);
  const statsMatch = realHtml.match(STATS_RE);
  const mesMatch = realHtml.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").match(MES_ENVIO_RE);

  if (!realPrices || realPrices.length < 3) throw new Error("No pude leer los 3 precios de la copa tamaño real en Empretienda (¿cambió el diseño de la página?)");
  if (!miniPrices || miniPrices.length < 2) throw new Error("No pude leer los 2 precios de la mini copa en Empretienda (¿cambió el diseño de la página?)");
  if (!statsMatch) throw new Error('No pude leer "años de experiencia / entregas" en Empretienda (¿cambió el texto?)');

  const fresh = {
    realSize: { listPrice: realPrices[0], transferPrice: realPrices[1], installment: realPrices[2] },
    mini: { listPrice: miniPrices[0], transferPrice: miniPrices[1] },
    aniosExperiencia: statsMatch[1],
    entregas: "+" + formatThousands(statsMatch[2]),
    // Si Empretienda dejara de decir el mes, no se frena la actualización de precios: queda en el control final.
    mesEnvio: mesMatch ? mesMatch[1].toLowerCase() : null,
  };

  const changes = [];
  let changed = false;

  function applyGlobalReplace(label, oldVal, newVal) {
    if (oldVal === newVal) return;
    if (!html.includes(oldVal)) {
      changes.push(`AVISO: no encontré "${oldVal}" (${label}) en index.html — no se pudo actualizar solo, revisar a mano.`);
      return;
    }
    html = html.split(oldVal).join(newVal);
    changes.push(`${label}: ${oldVal} -> ${newVal}`);
    changed = true;
  }

  applyGlobalReplace("Precio lista (tamaño real)", state.realSize.listPrice, fresh.realSize.listPrice);
  applyGlobalReplace("Precio transferencia (tamaño real)", state.realSize.transferPrice, fresh.realSize.transferPrice);
  applyGlobalReplace("Cuota (tamaño real)", state.realSize.installment, fresh.realSize.installment);
  applyGlobalReplace("Precio lista (mini)", state.mini.listPrice, fresh.mini.listPrice);
  applyGlobalReplace("Precio transferencia (mini)", state.mini.transferPrice, fresh.mini.transferPrice);
  applyGlobalReplace("Entregas", state.entregas, fresh.entregas);

  // "años de experiencia" necesita reemplazo con contexto: un número corto y suelto como
  // "24" no es seguro de reemplazar globalmente (podría pisar valores de CSS u otros números).
  if (state.aniosExperiencia !== fresh.aniosExperiencia) {
    const anchorRe = new RegExp(
      `(<p class="stat-num"[^>]*>)${state.aniosExperiencia}(</p>\\s*<p class="stat-label"[^>]*>años de experiencia</p>)`
    );
    if (anchorRe.test(html)) {
      html = html.replace(anchorRe, `$1${fresh.aniosExperiencia}$2`);
      changes.push(`Años de experiencia (stat): ${state.aniosExperiencia} -> ${fresh.aniosExperiencia}`);
      changed = true;
    } else {
      changes.push('AVISO: no encontré el bloque de stats "años de experiencia" para actualizar solo — revisar a mano.');
    }
    applyGlobalReplace("Años de experiencia (frase)", `${state.aniosExperiencia} años de experiencia`, `${fresh.aniosExperiencia} años de experiencia`);
  }

  // Mes de envío: se reemplaza por contexto (la frase completa), no el nombre del mes suelto.
  if (fresh.mesEnvio) {
    for (const { label, re } of FRASES_MES_ENVIO) {
      const m = html.match(re);
      if (m && m[2] !== fresh.mesEnvio) {
        html = html.replace(re, `$1${fresh.mesEnvio}$3`);
        changes.push(`${label}: ${m[2]} -> ${fresh.mesEnvio}`);
        changed = true;
      }
    }
  }

  // Control final, en cada corrida: la página tiene que mostrar exactamente lo que dice Empretienda.
  // Si algo no cuadra, el script falla (la corrida queda en rojo y GitHub avisa por mail) en vez de
  // dejar un aviso que al día siguiente desaparece.
  const problemas = [];
  const debeEstar = [
    ["Precio lista (tamaño real)", fresh.realSize.listPrice],
    ["Precio transferencia (tamaño real)", fresh.realSize.transferPrice],
    ["Cuota (tamaño real)", fresh.realSize.installment],
    ["Precio lista (mini)", fresh.mini.listPrice],
    ["Precio transferencia (mini)", fresh.mini.transferPrice],
    ["Entregas", fresh.entregas],
    ["Años de experiencia (frase)", `${fresh.aniosExperiencia} años de experiencia`],
  ];
  for (const [label, valor] of debeEstar) {
    if (!html.includes(valor)) problemas.push(`${label}: la página no muestra "${valor}"`);
  }
  const statRe = new RegExp(
    `<p class="stat-num"[^>]*>${fresh.aniosExperiencia}</p>\\s*<p class="stat-label"[^>]*>años de experiencia</p>`
  );
  if (!statRe.test(html)) problemas.push(`Años de experiencia (stat): no encontré el bloque con "${fresh.aniosExperiencia}"`);
  // Productos nuevos en la tienda: cualquier /<categoria>/<producto> del sitemap que no sea uno de los dos
  // de la landing ni esté en "ignoredProducts" del estado (productos que se decidió no mostrar).
  if (!sitemapXml) {
    problemas.push(`No pude leer el sitemap de Empretienda (${SITEMAP_URL}) para buscar productos nuevos`);
  } else {
    const normalizar = (u) => u.trim().replace(/\/+$/, "").toLowerCase();
    const conocidos = new Set([...Object.values(URLS), ...(state.ignoredProducts || [])].map(normalizar));
    const productos = [...sitemapXml.matchAll(/<loc>([^<]+)<\/loc>/g)]
      .map((m) => m[1])
      .filter((u) => new URL(u).pathname.split("/").filter(Boolean).length >= 2);
    const nuevos = productos.filter((u) => !conocidos.has(normalizar(u)));
    if (!productos.length) problemas.push("El sitemap de Empretienda no lista ningún producto (¿cambió el formato?)");
    if (nuevos.length) {
      problemas.push(
        `Hay ${nuevos.length} producto(s) nuevo(s) en Empretienda que la landing no muestra: ${nuevos.join(", ")}. ` +
          'Sumarlo(s) a la landing, o agregarlo(s) a "ignoredProducts" en scripts/empretienda-sync-state.json si no van.'
      );
    }
  }
  if (!fresh.mesEnvio) {
    problemas.push('No pude leer el mes de envío en Empretienda ("LA COMPRA SE ENVIA DURANTE EL MES DE ..."): ¿cambió el texto?');
  } else {
    for (const { label, re } of FRASES_MES_ENVIO) {
      const m = html.match(re);
      if (!m) problemas.push(`${label}: no encontré la frase en la página`);
      else if (m[2] !== fresh.mesEnvio) problemas.push(`${label}: la página dice "${m[2]}" y Empretienda "${fresh.mesEnvio}"`);
    }
  }
  const preciosValidos = new Set([...Object.values(fresh.realSize), ...Object.values(fresh.mini)]);
  const preciosDeMas = [...new Set(html.match(PRICE_RE) || [])].filter((p) => !preciosValidos.has(p));
  if (preciosDeMas.length) problemas.push(`La página muestra precios que no están en Empretienda: ${preciosDeMas.join(", ")}`);

  if (changed) {
    state.realSize = fresh.realSize;
    state.mini = fresh.mini;
    state.aniosExperiencia = fresh.aniosExperiencia;
    state.entregas = fresh.entregas;
    state.lastChanged = new Date().toISOString();
    fs.writeFileSync(HTML_PATH, html, "utf8");
  }
  state.lastChecked = new Date().toISOString();
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + "\n", "utf8");

  console.log(changed ? "CAMBIOS DETECTADOS:" : "Sin cambios respecto a Empretienda.");
  changes.forEach((c) => console.log(" - " + c));

  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `changed=${changed}\n`);
  }

  if (problemas.length) {
    console.error("ERROR: la landing no coincide con Empretienda, revisar a mano:");
    problemas.forEach((p) => console.error(" - " + p));
    process.exit(1);
  }
  console.log("Control OK: la landing muestra los mismos precios y datos que Empretienda.");
}

main().catch((err) => {
  console.error("ERROR:", err.message);
  process.exit(1);
});
