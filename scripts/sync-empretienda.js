const fs = require("fs");
const path = require("path");

const HTML_PATH = path.join(__dirname, "..", "index.html");
const STATE_PATH = path.join(__dirname, "empretienda-sync-state.json");

const URLS = {
  realSize: "https://copasmundiales.empretienda.com.ar/general/copa-del-mundo-tamano-real-version-pintada",
  mini: "https://copasmundiales.empretienda.com.ar/general/mini-copa-del-mundo-18-cm",
};

const PRICE_RE = /\$[0-9]{1,3}(?:\.[0-9]{3})*,[0-9]{2}/g;
const STATS_RE = /(\d+)\s*años de experiencia y más de\s*(\d+)\s*entregas/;

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

  const [realHtml, miniHtml] = await Promise.all([fetchText(URLS.realSize), fetchText(URLS.mini)]);

  const realPrices = realHtml.match(PRICE_RE);
  const miniPrices = miniHtml.match(PRICE_RE);
  const statsMatch = realHtml.match(STATS_RE);

  if (!realPrices || realPrices.length < 3) throw new Error("No pude leer los 3 precios de la copa tamaño real en Empretienda (¿cambió el diseño de la página?)");
  if (!miniPrices || miniPrices.length < 2) throw new Error("No pude leer los 2 precios de la mini copa en Empretienda (¿cambió el diseño de la página?)");
  if (!statsMatch) throw new Error('No pude leer "años de experiencia / entregas" en Empretienda (¿cambió el texto?)');

  const fresh = {
    realSize: { listPrice: realPrices[0], transferPrice: realPrices[1], installment: realPrices[2] },
    mini: { listPrice: miniPrices[0], transferPrice: miniPrices[1] },
    aniosExperiencia: statsMatch[1],
    entregas: "+" + formatThousands(statsMatch[2]),
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
  // "24" no es seguro de reemplazar globalmente (por ejemplo corrompería la clase Tailwind "mt-24").
  if (state.aniosExperiencia !== fresh.aniosExperiencia) {
    const anchorRe = new RegExp(
      `(<p class="font-display text-4xl text-gold"[^>]*>)${state.aniosExperiencia}(</p><p class="mt-1 text-sm text-muted-foreground"[^>]*>años de experiencia</p>)`
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
}

main().catch((err) => {
  console.error("ERROR:", err.message);
  process.exit(1);
});
