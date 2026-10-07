import { chromium } from 'playwright';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { items, extract, fixAmount, matches, parseGccPage, tk } from './lib.mjs';

const CFG = JSON.parse(readFileSync(new URL('./config.json', import.meta.url)));
const OUT = new URL('../docs/data.json', import.meta.url);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const median = a => { a = [...a].sort((x, y) => x - y); const h = a.length >> 1; return a.length % 2 ? a[h] : (a[h - 1] + a[h]) / 2; };

// --- Cache : évite de réinterroger eBay pour une carte déjà vérifiée récemment (gros gain de volume en scan horaire) ---
function loadCache() {
  try { return JSON.parse(readFileSync(OUT)).items.reduce((m, x) => (m[x.href] = x, m), {}); }
  catch (_) { return {}; }
}
function freshEnough(row, price) {
  return row && row.price === price && row.checkedAt && (Date.now() - row.checkedAt) < CFG.cacheHours * 3600000
    && (row.val != null || row.err); // on garde aussi en cache un échec récent, pour ne pas re-taper en boucle sur une carte introuvable
}

async function fx(cur) {
  if (cur === 'EUR') return 1;
  const r = await fetch(`https://api.frankfurter.app/latest?from=${cur}&to=EUR`).then(r => r.json());
  return r.rates.EUR;
}

// Bloque images/polices/médias : on ne lit que du texte, ça divise le volume de données par 5 à 10 (important avec un proxy payé au Go).
async function blockHeavyAssets(page) {
  await page.route('**/*', route => {
    const t = route.request().resourceType();
    (t === 'image' || t === 'font' || t === 'media') ? route.abort() : route.continue();
  });
}

let debugDumps = 0; // limite le nombre d'extraits HTML dumpés sur tout le scan (pour ne pas noyer le log)

async function ebayValue(page, c) {
  const q = [c.co ? c.co + ' ' + c.grade : '', c.name, c.numFull, c.set, c.lang === 'japanese' ? 'japan' : c.lang].join(' ').trim();
  const url = `https://www.ebay.fr/sch/i.html?_nkw=${encodeURIComponent(q)}&LH_Sold=1&LH_Complete=1&_sop=13&_ipg=60`;
  console.log('  requête :', q);
  console.log('  URL testée :', url);
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.waitForTimeout(1000);
    const html = await page.content();
    const pageTitle = (html.match(/<title[^>]*>([^<]*)</i) || [])[1] || '(aucun)';
    console.log(`  HTML reçu : ${html.length} caractères, titre de page : ${pageTitle}`);
    // eBay renvoie plusieurs variantes de blocage selon les cas : page d'erreur générique anti-robot (~1800
    // caractères), mur "pare-feu" Attention Required, ou redirection forcée vers la page de connexion
    // (une recherche normale n'exige jamais de se connecter).
    if (/error page/i.test(pageTitle) || /captcha|pardon our interruption/i.test(html.slice(0, 4000))) return { err: 'bloqué (anti-robot)' };
    if (/attention required|sorry, you have been blocked/i.test(html.slice(0, 2000))) return { err: 'bloqué (pare-feu)' };
    if (/se connecter ou s'inscrire|sign in or register/i.test(pageTitle)) return { err: 'bloqué (redirigé vers la connexion)' };
    const raw = items(html).map(extract).filter(Boolean);
    console.log(`  ${raw.length} annonces lues sur la page.`);
    if (raw.length === 0 && debugDumps < 5) {
      debugDumps++;
      console.log('  --- extrait HTML (diagnostic #' + debugDumps + ') ---\n  ' + html.replace(/\s+/g, ' ').slice(0, 2000) + '\n  --- fin extrait ---');
    }
    const found = raw.filter(it => matches(it, { name: c.name, set: c.set, num: c.num, lang: c.lang === 'japanese' ? 'japan' : c.lang, co: c.co, grade: c.grade }));
    if (!found.length) return { err: `aucune vente comparable (${raw.length} annonces lues)` };
    const eur = found.map(it => ({ ...it, eur: fixAmount(it.amount) * (RATES[it.cur] || 1) })).filter(x => x.eur > 0);
    eur.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    const vals = eur.slice(0, 8).map(x => x.eur);
    return {
      eur: median(vals), n: eur.length,
      sales: eur.slice(0, 5).map(x => ({ d: x.date || 'date inconnue', eur: Math.round(x.eur) })),
      conf: eur.length >= 5 ? 'bonne' : eur.length >= 2 ? 'moyenne' : 'faible'
    };
  } catch (e) { return { err: String(e.message || e).slice(0, 120) }; }
}

let RATES = { EUR: 1, USD: 1, GBP: 1 };

async function main() {
  console.log('Secrets détectés : PROXY_SERVER=' + (!!process.env.PROXY_SERVER) + ' | PROXY_USERNAME=' + (!!process.env.PROXY_USERNAME) + ' | PROXY_PASSWORD=' + (!!process.env.PROXY_PASSWORD));
  console.log('Variables d\'env. contenant "PROXY" (noms seulement) :', JSON.stringify(Object.keys(process.env).filter(k => /proxy/i.test(k))));
  console.log('Nombre total de variables d\'environnement reçues :', Object.keys(process.env).length);
  const launchArgs = { args: ['--disable-dev-shm-usage', '--disable-gpu'] };
  if (process.env.PROXY_SERVER) {
    launchArgs.proxy = { server: process.env.PROXY_SERVER, username: process.env.PROXY_USERNAME, password: process.env.PROXY_PASSWORD };
    console.log('Proxy activé :', process.env.PROXY_SERVER);
  } else {
    console.log('Pas de proxy configuré (secret PROXY_SERVER absent) — requêtes directes depuis GitHub.');
  }
  const browser = await chromium.launch(launchArgs);

  const gccPage = await browser.newPage({ locale: 'fr-FR' });
  await blockHeavyAssets(gccPage);
  console.log('Ouverture de GCC…');
  await gccPage.goto('https://gradedcardcenter.com/filtres/auctions', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await gccPage.waitForSelector('a[href*="/item/"]', { timeout: 20000 }).catch(() => {});
  await gccPage.waitForTimeout(2000);
  let cards = await gccPage.evaluate(parseGccPage);
  console.log(`${cards.length} enchères lues sur GCC.`);
  if (cards.length === 0) {
    const diag = await gccPage.evaluate(() => ({
      title: document.title, url: location.href, bodyLen: document.body.innerText.length,
      snippet: document.body.innerText.replace(/\s+/g, ' ').slice(0, 500),
      nItemLinks: document.querySelectorAll('a[href*="/item/"]').length
    }));
    console.log('  --- diagnostic GCC (0 carte) ---');
    console.log('  titre:', diag.title, '| url:', diag.url, '| texte:', diag.bodyLen, 'car. | liens /item/ :', diag.nItemLinks);
    console.log('  extrait:', diag.snippet);
    console.log('  --- fin diagnostic ---');
  }
  await gccPage.close();

  cards = cards.filter(c => !c.endTs || c.endTs <= Date.now() + CFG.horizonHours * 3600000)
    .sort((a, b) => (a.endTs || Infinity) - (b.endTs || Infinity))
    .slice(0, CFG.maxCards);
  console.log(`${cards.length} enchères retenues (horizon ${CFG.horizonHours} h, max ${CFG.maxCards}).`);

  RATES = { EUR: 1, USD: await fx('USD'), GBP: await fx('GBP') };
  const cache = loadCache();

  let workPage = await browser.newPage({ locale: 'fr-FR' });
  await blockHeavyAssets(workPage);
  const results = [];
  let fromCache = 0, fromLive = 0;

  for (const [i, c] of cards.entries()) {
    const cached = cache[c.href];
    let row = { href: c.href, title: c.title, game: c.game, price: c.price, endTs: c.endTs, co: c.co, grade: c.grade, lang: c.lang };

    if (freshEnough(cached, c.price)) {
      row = { ...cached, endTs: c.endTs, price: c.price }; // on garde le prix/l'estimation mis en cache, juste l'heure de fin est remise à jour
      fromCache++;
    } else {
      if (fromLive === 0) c._debug = true; // diagnostic sur la toute première VRAIE requête du scan
      let r = await ebayValue(workPage, c);
      if (r.err && /crash|closed|disconnected/i.test(r.err)) {
        console.log('  (page relancée après un incident)');
        try { await workPage.close(); } catch (_) {}
        workPage = await browser.newPage({ locale: 'fr-FR' }); await blockHeavyAssets(workPage);
        r = await ebayValue(workPage, c);
      }
      if (r.eur) {
        const cost = c.price * (1 + CFG.feePct / 100);
        const disc = 1 - cost / r.eur;
        const maxP = r.eur * (1 - CFG.marginPct / 100) / (1 + CFG.feePct / 100);
        row = { ...row, val: Math.round(r.eur), n: r.n, conf: r.conf, sales: r.sales, source: 'ebay', maxP: Math.round(maxP), gain: Math.round(r.eur - cost), disc: Math.round(disc * 1000) / 1000 };
      } else row.err = r.err;
      row.checkedAt = Date.now();
      fromLive++;
      await sleep(CFG.delayMs);
    }
    results.push(row);
    console.log(`${c.title} — ${c.price}€ → ${row.val ? row.val + '€ (' + row.n + ' ventes)' : (row.err || '?')}${freshEnough(cached, c.price) ? ' [cache]' : ''}`);

    if (i > 0 && i % 20 === 0) { try { await workPage.close(); } catch (_) {} workPage = await browser.newPage({ locale: 'fr-FR' }); await blockHeavyAssets(workPage); }
  }
  await browser.close();

  console.log(`Bilan : ${fromLive} requêtes réelles, ${fromCache} depuis le cache.`);
  results.sort((a, b) => (b.disc ?? -99) - (a.disc ?? -99));
  writeFileSync(OUT, JSON.stringify({ updated: Date.now(), items: results }, null, 0));
  console.log('data.json écrit :', results.length, 'enchères.');
}

main().catch(e => { console.error(e); process.exit(1); });
