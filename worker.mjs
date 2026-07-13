// Worker de actualización — Competitor Affiliate Tracker (YouTube)
// Corre en GitHub Actions cada 8h. Mismo pipeline que el dashboard:
// búsqueda multi-query → detalles → bola de nieve por canal → populares → acumular.
import fs from "fs";

const KEY = process.env.YT_API_KEY;
if (!KEY) { console.error("Falta el secret YT_API_KEY"); process.exit(1); }
const GEMINI_KEY = process.env.GEMINI_API_KEY; // opcional: verificación de mención hablada
const VERIFY_PER_RUN = 60; // vídeos por ejecución; el guard de cuota corta solo si el tier diario se agota

const config = JSON.parse(fs.readFileSync("config.json", "utf8"));
const REGIONS = ["US","GB","ES","MX","AR","CO","CL","FR","IT","DE","PT","BR","PL","LT","NL","TW","JP","CA","AU","IN"];
const PAID_RX = /(sponsored|paid partnership|patrocinad|c[óo]digo|promo ?code|coupon|% ?off|discount|descuento|#ad\b|use code|con el c[óo]digo|affiliate|link in|partnered with)/i;
const GENERIC = new Set(["blog","coupon","affiliate","creators-program","review","help","support","download","app","destinations","all-destinations","plans","es","en","fr","de","it","pt","nl","pl","world-football-tournament-esim","esim","pricing","business","refer-a-friend","esim-supported-devices"]);

const BUDGET = 2800; // unidades por ejecución (3 runs/día ≈ 8.400 de 10.000)
let quota = 0;

async function yt(path, params) {
  const cost = path === "search" ? 100 : 1;
  if (quota + cost > BUDGET) throw new Error("QUOTA");
  const u = new URL("https://www.googleapis.com/youtube/v3/" + path);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  u.searchParams.set("key", KEY);
  const r = await fetch(u);
  quota += cost;
  const j = await r.json();
  if (j.error) {
    const msg = j.error.message || "Error API";
    throw new Error(/quota/i.test(msg) ? "QUOTA" : msg); // cualquier error de cuota degrada la fase, no aborta el worker
  }
  return j;
}

function parseDur(iso) {
  const m = (iso || "").match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  return m ? (+(m[1] || 0)) * 3600 + (+(m[2] || 0)) * 60 + (+(m[3] || 0)) : 0;
}

function detectLang(t) {
  t = " " + t.toLowerCase() + " ";
  const scores = {
    es: [" el ", " la ", " los ", " que ", " con ", " para ", " como ", " mejor ", " viaje "],
    en: [" the ", " and ", " with ", " for ", " how ", " best ", " travel ", " this ", " you "],
    fr: [" le ", " les ", " des ", " pour ", " avec ", " comment ", " voyage "],
    it: [" il ", " gli ", " che ", " per ", " come ", " viaggio ", " migliore "],
    de: [" der ", " die ", " das ", " und ", " mit ", " für ", " reise "],
    pt: [" os ", " um ", " uma ", " não ", " como ", " melhor ", " viagem "]
  };
  let best = "?", max = 1;
  for (const [l, ws] of Object.entries(scores)) {
    const s = ws.reduce((a, w) => a + (t.split(w).length - 1), 0);
    if (s > max) { max = s; best = l; }
  }
  return best;
}

// extrae el código de afiliado REAL de una descripción; null si el enlace es genérico
// (rutas de idioma zh/ja/ko…, páginas de producto esim-*, secciones de la web)
function sanitizeCode(code) {
  if (!code) return null;
  const c = code.toLowerCase();
  if (GENERIC.has(c)) return null;
  if (/^[a-z]{2}(-[a-z]{2,4})?$/.test(c)) return null; // códigos de idioma (zh, ja, ko, zh-tw…)
  if (/^esim/.test(c)) return null;                     // páginas de producto (esim-usa…)
  if (c.length > 25) return null;
  return code;
}
// cada marca puede definir sus propios patrones de enlace de afiliado (linkPatterns);
// si no, el patrón por defecto es dominio/segmento (estilo saily.com/codigo)
function buildRXs(c) {
  const pats = c.linkPatterns || [c.domain.replace(/\./g, "\\.") + "/([\\w\\-]+)"];
  return pats.map(p => new RegExp(p, "i"));
}
function affCode(desc, RXs) {
  for (const RX of RXs) {
    const lm = (desc || "").match(RX);
    if (lm) { const code = sanitizeCode(lm[1]); if (code) return code; }
  }
  return null;
}

function mapVids(vids, name, RXs, c) {
  const excluded = new Set((c && c.excludeChannels) || []);
  const ctxTerms = (c && c.contextTerms) || [];
  return vids
    .filter(v => ((v.snippet.title + " " + v.snippet.description).toLowerCase().includes(name)))
    .filter(v => !excluded.has(v.snippet.channelId)) // homónimos conocidos fuera
    .map(v => {
      const sn = v.snippet, txt = sn.title + " " + sn.description;
      const declared = v.paidProductPlacementDetails?.hasPaidProductPlacement;
      const code = affCode(sn.description, RXs);
      const hasLink = !!code; // enlace de afiliado REAL, no un enlace cualquiera a la web
      const heur = PAID_RX.test(txt) && txt.toLowerCase().includes(name || "");
      // menciones sin enlace ni declaración: exigir contexto del sector para descartar homónimos
      if (!code && !declared && ctxTerms.length && !ctxTerms.some(t => txt.toLowerCase().includes(t))) return null;
      const dur = parseDur(v.contentDetails?.duration);
      return {
        id: v.id, title: sn.title, channel: sn.channelTitle, channelId: sn.channelId,
        date: sn.publishedAt.slice(0, 10),
        dur, format: dur ? (dur <= 183 ? "short" : "long") : null,
        lang: (sn.defaultAudioLanguage?.slice(0, 2) || sn.defaultLanguage?.slice(0, 2) || detectLang(txt)).toLowerCase(),
        views: +(v.statistics?.viewCount || 0),
        hasLink, code,
        // "paid" SOLO si YouTube lo declara oficialmente; enlace de afiliado = "maybe"
        // hasta que Gemini confirme mención hablada (entonces pasa a paid u organic)
        paid: (hasLink || heur || declared) ? "maybe" : "organic", // "paid" SOLO lo otorga la mención hablada verificada
        declared: !!declared
      };
    })
    .filter(Boolean);
}

async function fetchDetails(ids) {
  let vids = [];
  for (let i = 0; i < ids.length; i += 50) {
    const res = await yt("videos", { part: "snippet,statistics,contentDetails,paidProductPlacementDetails", id: ids.slice(i, i + 50).join(","), maxResults: "50" });
    vids = vids.concat(res.items || []);
  }
  return vids;
}

async function processCompetitor(c) {
  const name = c.name.toLowerCase();
  const RXs = buildRXs(c);
  const file = `data/${c.id}.json`;
  let state = { at: null, run: 0, videos: [], chanMeta: {} };
  if (fs.existsSync(file)) state = JSON.parse(fs.readFileSync(file, "utf8"));
  let prev = state.videos || [];
  const excludedMig = new Set(c.excludeChannels || []);
  prev = prev.filter(v => !excludedMig.has(v.channelId));
  // migración: sanear registros antiguos con códigos falsos (rutas de idioma, esim-*)
  prev.forEach(v => {
    v.code = sanitizeCode(v.code);
    v.hasLink = !!v.code;
    if (v.spoken === undefined && v.paid === "paid") v.paid = (v.hasLink || v.declared) ? "maybe" : "organic";
  });
  const run = (state.run || 0) + 1;

  // FASE 1 — búsqueda (extra queries rotan: 3 por ejecución)
  let idSet = new Set();
  try {
    for (const [qi, q] of c.queries.entries()) {
      // con varias marcas la cuota manda: doble pasada (fecha+relevancia) solo para la query principal
      const orders = qi === 0 ? ["date", "relevance"] : ["date"];
      for (const order of orders) {
        const res = await yt("search", { part: "id", q, type: "video", order, maxResults: "50" });
        (res.items || []).forEach(i => { if (i.id.videoId) idSet.add(i.id.videoId); });
      }
    }
    const extra = c.queriesExtra || [];
    for (let k = 0; k < Math.min(3, extra.length); k++) {
      const q = extra[(run * 3 + k) % extra.length];
      const res = await yt("search", { part: "id", q, type: "video", order: "date", maxResults: "50" });
      (res.items || []).forEach(i => { if (i.id.videoId) idSet.add(i.id.videoId); });
    }
  } catch (e) { if (e.message !== "QUOTA") throw e; console.log("Cuota agotada en fase 1"); }
  (c.seedVideos || []).forEach(v => idSet.add(v));
  prev.forEach(v => idSet.delete(v.id)); // ya conocidos: no re-consultar detalles aquí
  prev.filter(v => !v.dur).forEach(v => idSet.add(v.id)); // backfill: registros antiguos sin duración
  let data = [];
  try { data = mapVids(await fetchDetails([...idSet]), name, RXs, c); } catch (e) { if (e.message !== "QUOTA") throw e; }

  // FASE 2 — bola de nieve con cooldown y prioridad
  const linkCount = {};
  data.concat(prev).forEach(v => { if (v.hasLink && v.channelId) linkCount[v.channelId] = (linkCount[v.channelId] || 0) + 1; });
  const chanMeta = state.chanMeta || {};
  const now = Date.now(), COOLDOWN = 20 * 3600e3;
  // GRAFO COMPARTIDO: los creators del nicho rotan de sponsor, así que escaneamos
  // también los canales descubiertos por las DEMÁS marcas buscando enlaces de ESTA.
  let globalChans = [];
  for (const other of config.competitors) {
    const f2 = `data/${other.id}.json`;
    if (other.id !== c.id && fs.existsSync(f2)) {
      try { (JSON.parse(fs.readFileSync(f2, "utf8")).videos || []).forEach(v => { if (v.hasLink && v.channelId) globalChans.push(v.channelId); }); } catch (e) {}
    }
  }
  const chans = [...new Set(data.concat(prev).filter(v => v.hasLink && v.channelId).map(v => v.channelId).concat(c.seedChannels || []).concat(globalChans))]
    .filter(ch => !(chanMeta[ch] && now - chanMeta[ch] < COOLDOWN));
  let newIds = new Set();
  const have = new Set(data.map(v => v.id).concat(prev.map(v => v.id)));
  try {
    let uploads = {};
    for (let i = 0; i < chans.length; i += 50) {
      const res = await yt("channels", { part: "contentDetails", id: chans.slice(i, i + 50).join(","), maxResults: "50" });
      (res.items || []).forEach(ch => uploads[ch.id] = ch.contentDetails?.relatedPlaylists?.uploads);
    }
    for (const [chId, pl] of Object.entries(uploads)) {
      if (!pl) continue;
      const maxPages = (linkCount[chId] || 0) >= 2 ? 10 : 3;
      let tok = "";
      for (let p = 0; p < maxPages; p++) {
        const params = { part: "snippet", playlistId: pl, maxResults: "50" };
        if (tok) params.pageToken = tok;
        let res; try { res = await yt("playlistItems", params); } catch (e) { if (e.message === "QUOTA") throw e; break; }
        (res.items || []).forEach(it => {
          const vid = it.snippet?.resourceId?.videoId;
          if (vid && !have.has(vid) && affCode(it.snippet?.description, RXs)) newIds.add(vid);
        });
        tok = res.nextPageToken; if (!tok) break;
      }
      chanMeta[chId] = now;
    }
  } catch (e) { if (e.message !== "QUOTA") throw e; console.log("Cuota agotada en fase 2"); }
  let linkData = [];
  try { linkData = mapVids(await fetchDetails([...newIds]), "", RXs, c); } catch (e) { if (e.message !== "QUOTA") throw e; }

  // FASE 3 — populares por país
  let popData = [];
  try {
    let popIds = new Set();
    for (const rg of REGIONS) {
      const res = await yt("videos", { part: "snippet", chart: "mostPopular", regionCode: rg, maxResults: "50" });
      (res.items || []).forEach(v => { if (!have.has(v.id) && affCode(v.snippet?.description, RXs)) popIds.add(v.id); });
    }
    popData = mapVids(await fetchDetails([...popIds]), "", RXs, c);
  } catch (e) { if (e.message !== "QUOTA") throw e; console.log("Cuota agotada en fase 3"); }

  // ACUMULAR
  const byId = {};
  prev.forEach(v => byId[v.id] = v);
  data.concat(linkData).concat(popData).forEach(v => byId[v.id] = { ...(byId[v.id] || {}), ...v });
  const all = Object.values(byId);

  // FASE 4 — verificación de mención hablada con Gemini (escucha el audio real)
  if (GEMINI_KEY) {
    // TODO vídeo con enlace se verifica individualmente (los canales mezclan ad-reads
    // pagados con enlaces de plantilla, no se puede inferir por canal).
    // Orden: más views primero — donde está el impacto/inversión.
    const pend = all
      .filter(v => (v.hasLink || v.declared) && v.spoken === undefined && (v.vTries || 0) < 3 && v.dur && v.dur < 1500)
      .sort((a, b) => b.views - a.views)
      .slice(0, VERIFY_PER_RUN);
    for (const v of pend) {
      try {
        const verdict = await gemini(v.id, c.name, c.hint || "");
        v.spoken = !!verdict.spoken;
        v.spokenQuote = verdict.quote || null;
        v.spokenAt = verdict.second ?? null;
        v.paid = v.spoken ? "paid" : "organic";
        console.log(`  🎙 ${v.id} (${v.channel}): ${v.spoken ? "MENCIÓN HABLADA" : "solo enlace"}`);
      } catch (e) {
        v.vTries = (v.vTries || 0) + 1;
        console.log(`  🎙 ${v.id}: no verificado (${e.message.slice(0, 80)})`);
        if (/quota|rate|resource.?exhausted/i.test(e.message)) break; // tier del día agotado
      }
      await new Promise(r => setTimeout(r, 45000)); // respetar límite de tokens/minuto del tier gratis
    }
  }

  fs.mkdirSync("data", { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), run, videos: all, chanMeta }));
  const nl = all.filter(v => v.hasLink).length;
  const nv = all.filter(v => v.spoken !== undefined).length;
  console.log(`${c.id}: ${all.length} menciones (+${all.length - prev.length}) · ${nl} con enlace · ${nv} verificadas · cuota usada ~${quota}`);
}

async function gemini(videoId, brand, hint) {
  const models = ["gemini-flash-latest", "gemini-3.5-flash", "gemini-3.1-flash-lite"];
  const body = {
    contents: [{ parts: [
      { fileData: { fileUri: "https://www.youtube.com/watch?v=" + videoId },
        videoMetadata: { startOffset: "0s", endOffset: "360s" } }, // solo los primeros 6 min (donde vive el ad-read) para caber en el tier gratis
      { text: `Analiza el AUDIO de este fragmento de vídeo. ¿El creador menciona VERBALMENTE la marca "${brand}" (una eSIM de viaje${hint ? "; " + hint : ""})? Un enlace en la descripción NO cuenta: solo la voz. Responde SOLO JSON: {"spoken": true o false, "quote": "cita aproximada de la frase donde la menciona, o null", "second": segundo aproximado donde empieza, o null}` }
    ]}],
    generationConfig: { responseMimeType: "application/json", temperature: 0, mediaResolution: "MEDIA_RESOLUTION_LOW" }
  };
  let lastErr;
  for (const m of models) {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${GEMINI_KEY}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json();
    if (j.error) { lastErr = new Error(j.error.message); if (j.error.code === 404) continue; throw lastErr; }
    const txt = j.candidates?.[0]?.content?.parts?.[0]?.text || "";
    return JSON.parse(txt);
  }
  throw lastErr || new Error("sin modelo disponible");
}

for (const c of config.competitors) {
  try { await processCompetitor(c); }
  catch (e) { console.error(c.id + ": " + e.message); }
}
