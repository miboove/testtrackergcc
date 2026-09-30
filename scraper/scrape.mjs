import { chromium } from 'playwright';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { items, extract, fixAmount, matches } from './lib.mjs';
import { parseGccPage, parseCardmarketSearch, parseCardmarketArticles, tk } from './lib.mjs';

const CFG = JSON.parse(readFileSync(new URL('./config.json', import.meta.url)));
const OUT = new URL('../docs/data.json', import.meta.url);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const median = a => { a = [...a].sort((x, y) => x - y); const h = a.length >> 1; return a.length % 2 ? a[h] : (a[h - 1] + a[h]) / 2; };

async function fx(cur) {
  if (cur === 'EUR') return 1;
  const r = await fetch(`https://api.frankfurter.app/latest?from=${cur}&to=EUR`).then(r => r.json());
  return r.rates.EUR;
}

async function ebayValue(page, c, rates) {
  const q = [c.co ? c.co + ' ' + c.grade : '', c.name, c.numFull, c.set, c.lang === 'japanese' ? 'japan' : c.lang].join(' ').trim();
  const url = `https://www.ebay.fr/sch/i.html?_nkw=${encodeURIComponent(q)}&LH_Sold=1&LH_Complete=1&_sop=13&_ipg=60`;
  if (c._debug) console.log('  URL testée :', url);
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.waitForTimeout(1200);
    const html = await page.content();
    if (/captcha|pardon our interruption/i.test(html.slice(0, 4000))) return { err: 'bloqué' };
    const raw = items(html).map(extract).filter(Boolean);
    if (c._debug && raw.length === 0) console.log('  --- extrait HTML (diagnostic) ---\n' + html.replace(/\s+/g,' ').slice(0, 1500) + '\n  --- fin extrait ---');
    const found = raw.filter(it => matches(it, { name: c.name, set: c.set, num: c.num, lang: c.lang === 'japanese' ? 'japan' : c.lang, co: c.co, grade: c.grade }));
    if (!found.length) return { err: `aucune vente comparable (${raw.length} annonces lues, ${raw[0] ? '1ère: "' + raw[0].title.slice(0,60) + '"' : 'page vide, taille HTML=' + html.length} )` };
    const eur = found.map(it => ({ ...it, eur: fixAmount(it.amount) * (rates[it.cur] || 1) })).filter(x => x.eur > 0);
    eur.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    const top = eur.slice(0, 8), vals = top.map(x => x.eur);
    return {
      eur: median(vals), n: eur.length,
      sales: eur.slice(0, 5).map(x => ({ d: x.date || 'date inconnue', eur: Math.round(x.eur) })),
      conf: eur.length >= 5 ? 'bonne' : eur.length >= 2 ? 'moyenne' : 'faible'
    };
  } catch (e) { return { err: String(e.message || e).slice(0, 120) }; }
}

// Estimation Cardmarket : prix DEMANDÉS actuellement pour la même note/société de gradation (pas des ventes confirmées).
async function cardmarketValue(page, c, debug) {
  const cm = /riftbound/i.test(c.game) ? 'Riftbound' : 'Pokemon';
  const q = [c.name, c.set].join(' ').trim();
  const searchUrl = `https://www.cardmarket.com/fr/${cm}/Products/Search?searchString=${encodeURIComponent(q)}`;
  try {
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.waitForTimeout(1500);
    const candidates = await page.evaluate(parseCardmarketSearch);
    if (!candidates.length) return { err: 'aucun produit trouvé sur Cardmarket' };
    // on choisit la fiche produit dont le titre recoupe le mieux le nom/set/numéro de la carte
    const target = tk(c.name + ' ' + c.set + ' ' + c.numFull);
    let best = candidates[0], bestScore = -1;
    for (const cand of candidates) {
      const t = tk(cand.text);
      let score = 0; target.forEach(w => t.has(w) && score++);
      if (score > bestScore) { bestScore = score; best = cand; }
    }
    await page.goto(best.href, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.waitForTimeout(1500);
    const rows = await page.evaluate(parseCardmarketArticles);
    if (debug) console.log(`  Cardmarket : ${candidates.length} produits candidats, ${rows.length} lignes de prix gradés lues sur "${best.text.slice(0,60)}"`);
    const ok = rows.filter(r => r.co === c.co && Math.abs(r.grade - c.grade) < 0.01);
    if (!ok.length) return { err: `aucune annonce ${c.co || ''} ${c.grade || ''} sur Cardmarket (${rows.length} annonces gradées trouvées au total)` };
    const vals = ok.map(r => fixAmount(r.price)).filter(v => v > 0).sort((a, b) => a - b);
    if (!vals.length) return { err: 'prix illisibles' };
    return { ask: vals[Math.floor(vals.length / 2)], min: vals[0], n: vals.length, url: best.href };
  } catch (e) { return { err: String(e.message || e).slice(0, 120) }; }
}

async function main() {
  // --disable-dev-shm-usage : la mémoire partagée par défaut des conteneurs GitHub Actions (64 Mo) est trop
  // petite pour Chromium et le fait planter ("Page crashed") après quelques pages ; on le force à utiliser /tmp à la place.
  const browser = await chromium.launch({ args: ['--disable-dev-shm-usage', '--disable-gpu'] });
  const gccPage = await browser.newPage({ locale: 'fr-FR' });
  console.log('Ouverture de GCC…');
  await gccPage.goto('https://gradedcardcenter.com/filtres/auctions', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await gccPage.waitForSelector('a[href*="/item/"]', { timeout: 20000 }).catch(() => {});
  await gccPage.waitForTimeout(2000);
  let cards = await gccPage.evaluate(parseGccPage);
  console.log(`${cards.length} enchères lues sur GCC.`);
  await gccPage.close();

  cards = cards.filter(c => !c.endTs || c.endTs <= Date.now() + CFG.horizonHours * 3600000)
    .sort((a, b) => (a.endTs || Infinity) - (b.endTs || Infinity))
    .slice(0, CFG.maxCards);
  console.log(`${cards.length} enchères retenues (horizon ${CFG.horizonHours} h, max ${CFG.maxCards}).`);

  const rates = { EUR: 1, USD: await fx('USD'), GBP: await fx('GBP') };
  let workPage = await browser.newPage({ locale: 'fr-FR' });
  const results = [];
  for (const [i, c] of cards.entries()) {
    if (i === 0) c._debug = true; // affiche des infos de diagnostic pour la toute première carte
    let r = { err: 'eBay désactivé (CFG.useEbay=false)' };
    if (CFG.useEbay) {
      r = await ebayValue(workPage, c, rates);
      if (r.err && /crash/i.test(r.err)) { // la page a planté : on la remplace et on retente une fois
        console.log('  (page relancée après un crash)');
        try { await workPage.close(); } catch (_) {}
        workPage = await browser.newPage({ locale: 'fr-FR' });
        r = await ebayValue(workPage, c, rates);
      }
    }
    let cm = { err: 'Cardmarket désactivé' };
    if (CFG.useCardmarket) cm = await cardmarketValue(workPage, c, c._debug);

    if (i > 0 && i % 15 === 0) { // recycle périodique : évite l'accumulation de mémoire sur de longs scans
      try { await workPage.close(); } catch (_) {}
      workPage = await browser.newPage({ locale: 'fr-FR' });
    }

    let row = { href: c.href, title: c.title, game: c.game, price: c.price, endTs: c.endTs, co: c.co, grade: c.grade, lang: c.lang };
    if (r.eur) {
      // Ventes eBay confirmées : la source la plus fiable, utilisée en priorité quand disponible.
      const cost = c.price * (1 + CFG.feePct / 100);
      const disc = 1 - cost / r.eur;
      const maxP = r.eur * (1 - CFG.marginPct / 100) / (1 + CFG.feePct / 100);
      row = { ...row, val: Math.round(r.eur), n: r.n, conf: r.conf, sales: r.sales, source: 'ebay', maxP: Math.round(maxP), gain: Math.round(r.eur - cost), disc: Math.round(disc * 1000) / 1000 };
    } else if (cm.ask) {
      // Repli Cardmarket : prix DEMANDÉS, pas des ventes confirmées — marge de sécurité plus large et étiquette différente.
      const cost = c.price * (1 + CFG.feePct / 100);
      const disc = 1 - cost / cm.ask;
      const maxP = cm.ask * (1 - (CFG.marginPct + 10) / 100) / (1 + CFG.feePct / 100);
      row = { ...row, val: Math.round(cm.ask), n: cm.n, conf: cm.n >= 5 ? 'moyenne' : 'faible', source: 'cardmarket', estimate: true, maxP: Math.round(maxP), gain: Math.round(cm.ask - cost), disc: Math.round(disc * 1000) / 1000 };
    } else row.err = [r.err, cm.err].filter(Boolean).join(' · ');
    results.push(row);
    console.log(`${c.title} — ${c.price}€ → ${row.val ? row.val + '€ (' + row.source + ', ' + row.n + ')' : row.err}`);
    await sleep(CFG.delayMs);
  }
  await browser.close();

  results.sort((a, b) => (b.disc ?? -99) - (a.disc ?? -99));
  writeFileSync(OUT, JSON.stringify({ updated: Date.now(), items: results }, null, 0));
  console.log('data.json écrit :', results.length, 'enchères.');
}

main().catch(e => { console.error(e); process.exit(1); });
