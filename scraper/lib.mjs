// Fonctions de lecture/filtrage partagées, validées précédemment contre du vrai HTML eBay et GCC.
export const GR=/\b(PSA|CGC|BGS|PCA|SGC|TAG|ACE)\s*(?:(?:Pristine|Black(?: Label)?)\s*)?([\d.]+)\b/i;
export const LANGS=['japanese','japonais','korean','coreen','coréen','chinese','chinois','german','allemand','french','français','italian','italien','spanish','espagnol','portuguese','portugais'];
export const tk=s=>new Set(s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,' ').split(' ').filter(w=>w.length>1));

export function items(html){
  return html.split('<li').slice(1).filter(s=>/s-item(?!__)/.test(s.slice(0,400))).map(s=>'<li'+s);
}
export function extract(block){
  const title=(block.match(/s-item__title[^>]*>([\s\S]*?)<\/(?:div|span|h3)>/)||[])[1]?.replace(/<[^>]+>/g,'').trim();
  const eurConv=block.match(/Environ\s*([\d][\d.,]*)\s*EUR/i);
  const pr=block.match(/([\d][\d.,]*)\s*(EUR|USD|GBP|\$|€|£)/);
  const dt=(block.match(/(?:Vente réussie le|Objet vendu le|Vendu le|Sold)\s*([^<]{4,30})</i)||[])[1]?.trim();
  const href=(block.match(/href="([^"]+\/itm\/[^"]+)"/)||[])[1];
  if(!title||!(eurConv||pr))return null;
  if(eurConv)return {title,amount:eurConv[1],cur:'EUR',date:dt,href};
  const cur=/USD|\$/.test(pr[2])?'USD':/GBP|£/.test(pr[2])?'GBP':'EUR';
  return {title,amount:pr[1],cur,date:dt,href};
}
export function fixAmount(raw){
  raw=String(raw).trim();
  if(/,\d{2}$/.test(raw)&&raw.includes('.'))return parseFloat(raw.replace(/\./g,'').replace(',','.'));
  if(/\.\d{2}$/.test(raw)&&raw.includes(','))return parseFloat(raw.replace(/,/g,''));
  return parseFloat(raw.replace(',','.'));
}
export function matches(it,c){
  const t=it.title.toLowerCase();
  if(c.co){ const g=t.match(GR); if(!g||g[1].toUpperCase()!==c.co||Math.abs(parseFloat(g[2])-c.grade)>0.01)return false; }
  else if(GR.test(it.title))return false;
  if(c.lang){ if(!t.includes(c.lang))return false; }
  else if(LANGS.some(l=>t.includes(l)))return false;
  if(c.num && !t.includes(c.num))return false;
  const st=tk(c.name+' '+c.set),it_=tk(it.title);
  let sc=0; st.forEach(w=>it_.has(w)&&sc++);
  return sc>=Math.min(2,st.size);
}
// --- Cardmarket : première version, non testée en direct (le site n'a pas pu être inspecté depuis cet environnement) ---
// Approche volontairement souple : on lit le texte de la page plutôt que des sélecteurs CSS précis, pour résister
// aux détails de mise en forme qu'on ne connaît pas encore (même logique que le repli utilisé pour GCC).

// Étape 1, exécutée dans la page de résultats de recherche : liste les fiches produit candidates.
export const parseCardmarketSearch = function () {
  const links = [...document.querySelectorAll('a[href*="/Products/Singles/"]')];
  const seen = new Set();
  return links.map(a => ({ href: a.href, text: a.innerText.trim() }))
    .filter(x => x.text && !seen.has(x.href) && seen.add(x.href))
    .slice(0, 15);
};

// Étape 2, exécutée sur la fiche produit : repère les lignes de prix et regarde si une mention de gradation
// (PSA/CGC/BGS/SGC + note) apparaît dans les quelques lignes qui précèdent (structure habituelle d'un tableau d'annonces).
export const parseCardmarketArticles = function () {
  const GR = /\b(PSA|CGC|BGS|SGC|ACE)\s*([\d.]+)\b/i;
  const L = document.body.innerText.split('\n').map(s => s.trim()).filter(Boolean);
  const priceRe = /^([\d][\d.,]*)\s*€$/;
  const out = [];
  L.forEach((line, i) => {
    const pm = line.match(priceRe);
    if (!pm) return;
    const ctx = L.slice(Math.max(0, i - 6), i + 1).join(' ');
    const gm = ctx.match(GR);
    if (!gm) return;
    out.push({ price: pm[1], co: gm[1].toUpperCase(), grade: parseFloat(gm[2]), context: ctx.slice(0, 140) });
  });
  return out;
};

// Lecture d'une carte GCC, exécutée DANS la page via page.evaluate (même logique que content.js, validée sur le vrai site).
export const parseGccPage=function(){
  const SEP=/[•·‧∙⋅|]/g;
  const GR2=/^(PSA|CGC|BGS|PCA|SGC|TAG|ACE)\s*(?:(?:Pristine|Black(?: Label)?)\s*)?([\d.]+)\s*/i;
  const toNum=t=>parseFloat(t.replace(/[\s'’\u202f\u00a0]/g,'').replace(',','.'));
  const out=[];
  document.querySelectorAll('a[href*="/item/"]').forEach(a=>{
    let el=a;
    while(el.parentElement&&new Set([...el.parentElement.querySelectorAll('a[href*="/item/"]')].map(x=>x.href)).size===1)el=el.parentElement;
    if(out.find(x=>x.href===a.href))return;
    const L=el.innerText.split('\n').map(s=>s.trim()).filter(Boolean);
    let mi=L.findIndex(l=>(l.match(SEP)||[]).length>=3),parts;
    if(mi>=1)parts=L[mi].split(SEP).map(s=>s.trim()).filter(Boolean);
    else{ mi=L.findIndex(l=>/^(pok[eé]mon|riftbound)\b/i.test(l)); if(mi<1)return; parts=L[mi].split(/\s+\S{1,2}\s+/).map(s=>s.trim()).filter(Boolean); if(parts.length<3)return; }
    const pl=L.slice(mi).find(l=>/^[\d\s'’.,]+€$/.test(l)); if(!pl)return;
    const title=L[mi-1],p=parts,g=title.match(GR2),numFull=(p.find(x=>/^#/.test(x))||'').slice(1);
    const em=L.join(' ').match(/Fin le (\d\d)\/(\d\d) @ (\d\d)h(\d\d)/);
    let endTs=null;
    if(em){const n=new Date(),e=new Date(n.getFullYear(),+em[2]-1,+em[1],+em[3],+em[4]);if(e<n-2592e6)e.setFullYear(e.getFullYear()+1);endTs=+e;}
    out.push({href:a.href,title,game:p[0],lang:(p[1]||'').toLowerCase(),
      set:p.slice(3).filter(x=>!/^#|unlimited|1st edition|shadowless/i.test(x)).join(' '),
      numFull,num:numFull.split('/')[0].replace(/^0+/,'').toLowerCase(),name:title.replace(GR2,''),
      co:g?g[1].toUpperCase():null,grade:g?parseFloat(g[2]):0,price:toNum(pl),endTs});
  });
  return out;
};
