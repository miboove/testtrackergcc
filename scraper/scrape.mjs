import { chromium } from 'playwright';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { items, extract, fixAmount, matches } from './lib.mjs';
import { parseGccPage } from './lib.mjs';

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
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.waitForTimeout(1200);
    const html = await page.content();
    if (/captcha|pardon our interruption/i.test(html.slice(0, 4000))) return { err: 'bloqué' };
    const found = items(html).map(extract).filter(Boolean)
      .filter(it => matches(it, { name: c.name, set: c.set, num: c.num, lang: c.lang === 'japanese' ? 'japan' : c.lang, co: c.co, grade: c.grade }));
    if (!found.length) return { err: 'aucune vente comparable' };
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

async function main() {
  const browser = await chromium.launch();
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
  const ebayPage = await browser.newPage({ locale: 'fr-FR' });
  const results = [];
  for (const c of cards) {
    const r = await ebayValue(ebayPage, c, rates);
    let row = { href: c.href, title: c.title, game: c.game, price: c.price, endTs: c.endTs, co: c.co, grade: c.grade, lang: c.lang };
    if (r.eur) {
      const cost = c.price * (1 + CFG.feePct / 100);
      const disc = 1 - cost / r.eur;
      const maxP = r.eur * (1 - CFG.marginPct / 100) / (1 + CFG.feePct / 100);
      row = { ...row, val: Math.round(r.eur), n: r.n, conf: r.conf, sales: r.sales, maxP: Math.round(maxP), gain: Math.round(r.eur - cost), disc: Math.round(disc * 1000) / 1000 };
    } else row.err = r.err;
    results.push(row);
    console.log(`${c.title} — ${c.price}€ → ${r.eur ? Math.round(r.eur) + '€ (' + r.n + ' ventes)' : r.err}`);
    await sleep(CFG.delayMs);
  }
  await browser.close();

  results.sort((a, b) => (b.disc ?? -99) - (a.disc ?? -99));
  writeFileSync(OUT, JSON.stringify({ updated: Date.now(), items: results }, null, 0));
  console.log('data.json écrit :', results.length, 'enchères.');
}

main().catch(e => { console.error(e); process.exit(1); });
