// Worker de actualización — Competitor Affiliate Tracker (YouTube)
// Corre en GitHub Actions cada 8h. Mismo pipeline que el dashboard:
// búsqueda multi-query → detalles → bola de nieve por canal → populares → acumular.
import fs from "fs";

const KEY = process.env.YT_API_KEY;
if (!KEY) { console.error("Falta el secret YT_API_KEY"); process.exit(1); }
const GEMINI_KEY = process.env.GEMINI_API_KEY; // fallback: vídeos sin transcript
const APIFY_TOKEN = process.env.APIFY_TOKEN;       // vía principal: transcripts vía Apify (~$0.001/vídeo)
const TRANSCRIPTS_PER_RUN = 2000; // transcripts por ejecución (plan de pago: ~$2/run mientras haya backlog, luego céntimos)
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
    // los "sin mención" verificados con la ventana antigua de 6 min no valen si el vídeo es más largo
    if (v.spoken === false && !v.vFull && v.dur > 360 && (v.hasLink || v.declared)) {
      delete v.spoken; delete v.spokenQuote; delete v.spokenAt; v.vTries = 0; v.paid = "maybe";
    }
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
  // FASE 1b — backlinks del dominio (índice SEO vía Apify): encuentra vídeos históricos
  // de canales que nunca pasaron por la búsqueda. Una vez al día (run % 3 === 1).
  if (APIFY_TOKEN && run % 3 === 1) {
    try {
      const items = await apifyRunActor("s-r~backlinks-checker", { domain: c.domain, include_backlinks: true });
      const txt = JSON.stringify(items).split(String.fromCharCode(92) + "/").join("/"); // normalizar barras escapadas
      const found = new Set();
      for (const marker of ["youtube.com/watch?v=", "youtu.be/"]) {
        let i = 0;
        while ((i = txt.indexOf(marker, i)) !== -1) {
          const id = txt.slice(i + marker.length, i + marker.length + 11);
          if (/^[\w-]{11}$/.test(id)) found.add(id);
          i += marker.length;
        }
      }
      found.forEach(id => idSet.add(id));
      console.log(`  🔗 backlinks: ${found.size} vídeos de YouTube enlazando a ${c.domain}`);
    } catch (e) { console.log("backlinks: " + String(e.message).slice(0, 100)); }
  }
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

  // FASE 3b — snapshot diario de views (Δ24h, Δ7d y "views del mes": nuevos vs catálogo)
  // Refresca statistics de vídeos de los últimos 12 meses + todas las pagadas ✓ (1 unidad por cada 50).
  try {
    const today = new Date().toISOString().slice(0, 10);
    const month = today.slice(0, 7);
    const cutRefresh = new Date(Date.now() - 365 * 864e5).toISOString().slice(0, 10);
    const targets = all.filter(v => v.date >= cutRefresh || v.paid === "paid");
    if (targets.length && state.snapAt !== today) {
      const dayAgg = { d: today, total: 0, nuevos: 0, cat: 0, vids: {} }; // serie diaria persistida
      for (let i = 0; i < targets.length; i += 50) {
        const chunk = targets.slice(i, i + 50);
        const res = await yt("videos", { part: "statistics", id: chunk.map(v => v.id).join(","), maxResults: "50" });
        const m = {}; (res.items || []).forEach(it => m[it.id] = +(it.statistics?.viewCount || 0));
        for (const v of chunk) {
          const nv = m[v.id]; if (nv === undefined) continue;
          if (v.snapAt && (v.hasLink || v.paid === "paid")) { // delta real solo si ya había snapshot previo
            const dl = Math.max(0, nv - v.views);
            dayAgg.total += dl;
            if ((v.date || "").slice(0, 7) === month) dayAgg.nuevos += dl; else dayAgg.cat += dl;
            if (dl >= 100) dayAgg.vids[v.id] = dl; // detalle solo de los que se mueven
          }
          if (v.vM0m !== month) { v.vPrev = (v.vM0 !== undefined) ? Math.max(0, v.views - v.vM0) : null; v.vM0 = v.views; v.vM0m = month; }
          if (!v.vWAt || (Date.parse(today) - Date.parse(v.vWAt)) >= 7 * 864e5) { v.vW = v.views; v.vWAt = today; }
          v.vD = v.views; v.vDAt = v.snapAt || null;
          v.views = nv; v.snapAt = today;
        }
      }
      state.snapAt = today;
      try { // histórico diario por marca: data/{id}-daily.json (retención ~13 meses)
        const df = `data/${c.id}-daily.json`;
        const hist = fs.existsSync(df) ? JSON.parse(fs.readFileSync(df, "utf8")) : [];
        if (!hist.length || hist[hist.length - 1].d !== today) hist.push(dayAgg);
        fs.writeFileSync(df, JSON.stringify(hist.slice(-400)));
      } catch (e2) { console.log("daily: " + String(e2.message).slice(0, 80)); }
      console.log(`  \ud83d\udcc8 snapshot: ${targets.length} v\u00eddeos \u00b7 hoy +${dayAgg.total} views (${dayAgg.nuevos} nuevos / ${dayAgg.cat} cat\u00e1logo)`);
    }
  } catch (e) { if (e.message !== "QUOTA") throw e; console.log("Cuota agotada en snapshot de views"); }

  // FASE 4a — verificación por TRANSCRIPT (Apify): barata y masiva; la regla:
  // si la marca aparece en lo HABLADO del vídeo → pagada; si solo hay enlace → orgánica.
  if (APIFY_TOKEN) {
    const pendT = all
      .filter(v => (v.hasLink || v.declared) && v.spoken === undefined && v.tTried === undefined)
      .sort((a, b) => b.views - a.views)
      .slice(0, TRANSCRIPTS_PER_RUN);
    const variants = (c.spokenVariants || [c.name.toLowerCase()]);
    const RXv = new RegExp("\\b(" + variants.map(s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")\\b", "i");
    // agrupar por idioma del vídeo para pedir la pista de subtítulos correcta (no la traducción)
    const groups = {};
    pendT.forEach(v => { const l = /^[a-z]{2}$/.test(v.lang || "") ? v.lang : "en"; (groups[l] = groups[l] || []).push(v); });
    const batches = [];
    for (const [lang, vids] of Object.entries(groups)) {
      for (let i = 0; i < vids.length; i += 100) batches.push({ lang, batch: vids.slice(i, i + 100) });
    }
    const CONC = 5; // lotes en paralelo (el plan de pago permite runs concurrentes de sobra)
    for (let w = 0; w < batches.length; w += CONC) {
      await Promise.all(batches.slice(w, w + CONC).map(async ({ lang, batch }) => {
        try {
          const items = await apifyTranscripts(batch.map(v => v.id), lang);
          const byVid = {};
          items.forEach(it => {
            const u = it.videoUrl || it.video_url || it.url || it.inputUrl || "";
            const id = it.videoId || it.video_id || (u.match(/[?&]v=([\w-]{11})/) || [])[1];
            if (id) byVid[id] = it;
          });
          for (const v of batch) {
            const it = byVid[v.id];
            v.tTried = true;
            const raw = it && !it.error ? (it.text || it.transcript || it.transcript_text || it.plain_text) : null;
            if (!raw) continue; // sin transcript → lo escuchará Gemini
            const text = typeof raw === "string" ? raw : JSON.stringify(raw);
            const m = text.match(RXv);
            v.spoken = !!m; v.vFull = true; v.vSrc = "transcript";
            if (m) { const idx = text.toLowerCase().indexOf(m[0].toLowerCase()); v.spokenQuote = text.slice(Math.max(0, idx - 60), idx + 100).trim(); v.spokenAt = null; }
            else { v.spokenQuote = null; v.spokenAt = null; }
            v.paid = v.spoken ? "paid" : "organic";
            console.log(`  📜 ${v.id} (${v.channel}): ${v.spoken ? "MENCIÓN EN TRANSCRIPT" : "sin mención"}`);
          }
        } catch (e) { console.log("apify: " + String(e.message).slice(0, 100)); }
      }));
    }
  }

  // FASE 4b — fallback con Gemini (escucha el audio real) para vídeos SIN transcript
  if (GEMINI_KEY) {
    // TODO vídeo con enlace se verifica individualmente (los canales mezclan ad-reads
    // pagados con enlaces de plantilla, no se puede inferir por canal).
    // Orden: más views primero — donde está el impacto/inversión.
    const pend = all
      .filter(v => (v.hasLink || v.declared) && v.spoken === undefined && (!APIFY_TOKEN || v.tTried) && (v.vTries || 0) < 3 && v.dur && v.dur < 1500)
      .sort((a, b) => b.views - a.views)
      .slice(0, VERIFY_PER_RUN);
    for (const v of pend) {
      try {
        const verdict = await gemini(v.id, c.name, c.hint || "");
        v.spoken = !!verdict.spoken;
        v.vFull = true; // veredicto sobre el vídeo completo
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
  fs.writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), run, snapAt: state.snapAt || null, videos: all, chanMeta }));
  const nl = all.filter(v => v.hasLink).length;
  const nv = all.filter(v => v.spoken !== undefined).length;
  console.log(`${c.id}: ${all.length} menciones (+${all.length - prev.length}) · ${nl} con enlace · ${nv} verificadas · cuota usada ~${quota}`);
}

// lanza un actor de Apify y devuelve los items del dataset al terminar
async function apifyRunActor(actor, input) {
  const r = await fetch(`https://api.apify.com/v2/acts/${actor}/runs?token=${APIFY_TOKEN}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  const runId = j.data.id;
  let run = j.data;
  for (let t = 0; t < 90 && !["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"].includes(run.status); t++) {
    await new Promise(rr => setTimeout(rr, 10000));
    run = (await (await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${APIFY_TOKEN}`)).json()).data;
  }
  if (run.status !== "SUCCEEDED") throw new Error("run apify " + run.status);
  return await (await fetch(`https://api.apify.com/v2/datasets/${run.defaultDatasetId}/items?token=${APIFY_TOKEN}&clean=true`)).json();
}
// transcripts de YouTube (captions) vía Apify
function apifyTranscripts(ids, lang) {
  return apifyRunActor("codepoetry~youtube-transcript-ai-scraper", {
    startUrls: ids.map(id => ({ url: "https://www.youtube.com/watch?v=" + id })),
    languages: [...new Set([lang, "en", "es", "fr", "it", "de", "pt", "pl", "nl", "ja", "ru", "tr", "ko"])],
    subType: "both", outputFormats: ["text"], enableAiFallback: false
  });
}

async function gemini(videoId, brand, hint) {
  const models = ["gemini-flash-latest", "gemini-3.5-flash", "gemini-3.1-flash-lite"];
  const body = {
    contents: [{ parts: [
      { fileData: { fileUri: "https://www.youtube.com/watch?v=" + videoId } }, // vídeo completo: el ad-read puede ir a mitad o al final (dur<1500 limita el coste)
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

// ================================================================
// FASES GLOBALES (tras procesar todas las marcas)
// ================================================================
// A — share of search semanal: quién aparece en las búsquedas genéricas de eSIM por mercado
const SERP_MARKETS = {
  US: { gl: "us", hl: "en", queries: ["best esim for travel", "best esim 2026", "esim for europe travel", "esim for japan", "esim review"] },
  GB: { gl: "gb", hl: "en", queries: ["best esim uk", "best esim for travel", "esim for usa", "esim europe", "esim review"] },
  ES: { gl: "es", hl: "es", queries: ["mejor esim para viajar", "esim para europa", "esim para estados unidos", "esim opiniones", "que esim comprar"] },
  MX: { gl: "mx", hl: "es", queries: ["mejor esim para viajar", "esim para europa", "esim para usa", "esim opiniones"] },
  FR: { gl: "fr", hl: "fr", queries: ["meilleure esim voyage", "esim pour le japon", "esim europe", "esim avis"] },
  IT: { gl: "it", hl: "it", queries: ["migliore esim viaggio", "esim per stati uniti", "esim recensione", "esim europa"] },
  DE: { gl: "de", hl: "de", queries: ["beste esim reisen", "esim usa", "esim test", "esim europa"] },
  BR: { gl: "br", hl: "pt", queries: ["melhor esim viagem", "esim para europa", "esim vale a pena", "esim internacional"] }
};
async function serpWeekly() {
  if (!APIFY_TOKEN) return;
  const today = new Date().toISOString().slice(0, 10);
  const file = "data/serp.json";
  let hist = [];
  try { if (fs.existsSync(file)) hist = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) {}
  if (hist.length && (Date.parse(today) - Date.parse(hist[hist.length - 1].d)) < 6.5 * 864e5) return; // semanal
  const brandRX = {};
  for (const c of config.competitors) {
    const pats = (c.spokenVariants || [c.name.toLowerCase()]).map(s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    pats.push(c.domain.replace(/\./g, "\\."));
    brandRX[c.id] = new RegExp("\\b(" + pats.join("|") + ")\\b", "i");
  }
  const entry = { d: today, markets: {} };
  for (const [mk, m] of Object.entries(SERP_MARKETS)) {
    const scores = {}; let totalW = 0;
    for (const q of m.queries) {
      try {
        const items = await apifyRunActor("apidojo~youtube-scraper-api", { keywords: [q], gl: m.gl, hl: m.hl, maxItems: 20, sort: "r" });
        items.slice(0, 20).forEach((it, idx) => {
          const txt = JSON.stringify(it);
          const w = 1 / (idx + 1); totalW += w;
          for (const c of config.competitors) if (brandRX[c.id].test(txt)) scores[c.id] = (scores[c.id] || 0) + w;
        });
      } catch (e) { console.log("serp " + mk + " \u00ab" + q + "\u00bb: " + String(e.message).slice(0, 60)); }
    }
    entry.markets[mk] = {};
    for (const c of config.competitors) entry.markets[mk][c.id] = totalW ? +(100 * (scores[c.id] || 0) / totalW).toFixed(1) : 0;
    console.log("  \ud83d\udd0d " + mk + ": " + Object.entries(entry.markets[mk]).map(([k, v]) => k + " " + v + "%").join(" \u00b7 "));
  }
  hist.push(entry);
  fs.writeFileSync(file, JSON.stringify(hist.slice(-60)));
}

// B — clasificación de canales por vertical (Gemini, solo texto): data/channels.json
async function classifyVerticals() {
  if (!GEMINI_KEY) return;
  const file = "data/channels.json";
  let db = {};
  try { if (fs.existsSync(file)) db = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) {}
  const chans = {};
  for (const c of config.competitors) {
    const f = `data/${c.id}.json`;
    if (!fs.existsSync(f)) continue;
    (JSON.parse(fs.readFileSync(f, "utf8")).videos || []).forEach(v => {
      if (!v.channelId || db[v.channelId]) return;
      const ch = chans[v.channelId] = chans[v.channelId] || { name: v.channel, titles: [] };
      if (ch.titles.length < 3) ch.titles.push(v.title);
    });
  }
  const ids = Object.keys(chans).slice(0, 400); // tope por ejecución
  if (!ids.length) return;
  const TAX = ["viajes", "tech", "divulgacion", "deportes", "finanzas", "lifestyle", "gaming", "entretenimiento", "noticias", "otro"];
  let done = 0;
  for (let i = 0; i < ids.length; i += 40) {
    const batch = ids.slice(i, i + 40);
    const lines = batch.map(id => `${id} :: ${chans[id].name} :: ${chans[id].titles.join(" | ")}`).join("\n");
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${GEMINI_KEY}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: `Clasifica cada canal de YouTube en UNA vertical de esta lista exacta: ${TAX.join(", ")}. Cada l\u00ednea es "channelId :: nombre del canal :: t\u00edtulos de v\u00eddeos". Responde SOLO JSON: {"channelId": "vertical", ...}\n\n${lines}` }] }],
          generationConfig: { responseMimeType: "application/json", temperature: 0 }
        })
      });
      const j = await r.json();
      if (j.error) throw new Error(j.error.message);
      const map = JSON.parse(j.candidates?.[0]?.content?.parts?.[0]?.text || "{}");
      for (const [id, v] of Object.entries(map)) if (chans[id] && TAX.includes(String(v).toLowerCase())) { db[id] = { v: String(v).toLowerCase(), n: chans[id].name }; done++; }
    } catch (e) { console.log("verticales: " + String(e.message).slice(0, 80)); break; }
    await new Promise(r2 => setTimeout(r2, 5000));
  }
  if (done) { fs.writeFileSync(file, JSON.stringify(db)); console.log(`  \ud83c\udff7\ufe0f verticales: ${done} canales clasificados (${Object.keys(db).length} total)`); }
}

for (const c of config.competitors) {
  try { await processCompetitor(c); }
  catch (e) { console.error(c.id + ": " + e.message); }
}
try { await serpWeekly(); } catch (e) { console.error("serp: " + e.message); }
try { await classifyVerticals(); } catch (e) { console.error("verticales: " + e.message); }
