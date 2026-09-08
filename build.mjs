// Generatore del sito di documentazione.
//
//   npm run build     genera un .html accanto a ogni .md descritto in SITE
//   npm run clean     rimuove gli .html generati
//
// I file Markdown in docs/ sono l'unica fonte: l'HTML è sempre derivato e non va
// modificato a mano. La struttura qui sotto genera la home, la barra laterale,
// l'ordine di lettura e l'indice della ricerca (docs/assets/search-index.js):
// aggiungere una pagina significa aggiungere una voce a SITE.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import MarkdownIt from 'markdown-it';
import hljs from 'highlight.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DOCS = path.join(ROOT, 'docs');

const SITE = {
  title: 'app-boilerplate',
  subtitle: 'Documentazione tecnica del template',
  // Versione del template descritta da queste pagine: coincide con l'ultimo tag di
  // app-boilerplate (vedi il suo CHANGELOG.md). Compare nel piè di pagina.
  templateVersion: 'in preparazione (nessun tag ancora)',
  sections: [
    {
      title: 'Progetto',
      pages: [
        {
          file: 'progetto/panoramica.md',
          title: 'Panoramica',
          summary: 'Che cos’è il boilerplate, com’è fatto il monorepo generato, quali sono le convenzioni.',
        },
        {
          file: 'progetto/generazione.md',
          title: 'Generare e aggiornare',
          summary: 'Le variabili del template, come nasce un progetto con Copier e come si aggiorna quando il template cambia.',
        },
        {
          file: 'progetto/configurazione.md',
          title: 'Configurazione',
          summary: 'appsettings, appsettings.local.json, variabili d’ambiente e VITE_*: tutte le chiavi, dove si mettono, quali sono obbligatorie.',
        },
        {
          file: 'progetto/skill.md',
          title: 'Le skill Claude',
          summary: 'Le skill incluse nel template: che cosa scaffoldano e quando conviene invocarle.',
        },
        {
          file: 'progetto/contribuire.md',
          title: 'Contribuire al template',
          summary: 'Che cos’è app-demo, come si riportano le modifiche nel template, che cosa resta diverso, come si rilascia una versione.',
        },
      ],
    },
    {
      title: 'Architettura',
      pages: [
        {
          file: 'architettura/clean-architecture.md',
          title: 'Clean Architecture',
          summary: 'I quattro layer, la regola delle dipendenze e i test che la fanno rispettare dalla build.',
        },
        {
          file: 'architettura/dove-mettere-la-logica.md',
          title: 'Dove mettere la logica',
          summary: 'Handler, domain service o aggregato: la domanda che decide, con gli esempi reali del progetto.',
        },
        {
          file: 'architettura/il-dominio.md',
          title: 'Il dominio',
          summary: 'Aggregati, value object, macchine a stati, eventi e specification: i mattoni e quando usarli.',
        },
        {
          file: 'architettura/comandi-e-query.md',
          title: 'Comandi e query',
          summary: 'Repository e unit of work per le scritture, IReadDbContext per le letture. Perché due strade.',
        },
      ],
    },
    {
      title: 'Frontend',
      pages: [
        {
          file: 'frontend/struttura.md',
          title: 'Struttura del progetto',
          summary: 'Le cartelle di apps/frontend una per una: che cosa contengono, quando serve aggiungerci qualcosa e quando no.',
        },
        {
          file: 'frontend/convenzioni.md',
          title: 'Convenzioni e flussi',
          summary: 'Store con useAsyncAction, liste con useServerTable, errori, dialog, permessi, navigazione e test: come si scrive una feature.',
        },
      ],
    },
    {
      title: 'Infrastruttura',
      pages: [
        {
          file: 'infrastructure/panoramica.md',
          title: 'Il doppio provider',
          summary: 'SQL Server o PostgreSQL da configurazione: come funziona, la pipeline delle richieste, che cosa è già pronto.',
        },
        {
          file: 'infrastructure/architettura.md',
          title: 'Modello EF e schema',
          summary: 'Un solo AppDbContext, il modello EF Core, lo schema relazionale, i due set di migration.',
        },
        {
          file: 'infrastructure/implementazione.md',
          title: 'Il codice',
          summary: 'Switch in DI, AppDbContext, interceptor, pipeline MediatR, handler, migration, seed.',
        },
        {
          file: 'infrastructure/audit-log.md',
          title: 'Audit log',
          summary: 'Chi ha fatto cosa, con gli snapshot prima e dopo: come lo scrive l’interceptor, che cosa non traccia, che cosa deve fare un repository.',
        },
        {
          file: 'infrastructure/decisioni.md',
          title: 'Decisioni',
          summary: 'Perché la chiave primaria è int identity, perché i repository solo sulle scritture, che cosa è stato scartato.',
        },
      ],
    },
    {
      title: 'Autenticazione',
      pages: [
        {
          file: 'autenticazione/autenticazione.md',
          title: 'JWT, MSAL e Windows',
          summary: 'Le tre strategie di accesso, i flussi, il codice e la risoluzione dei permessi.',
        },
        {
          file: 'autenticazione/azure-app-registration.md',
          title: 'App registration Azure',
          summary: 'Guida operativa: registrare SPA e API su Entra ID e configurare il progetto.',
        },
      ],
    },
    {
      title: 'Guide',
      pages: [
        {
          file: 'guide/nuova-feature.md',
          title: 'Aggiungere una feature',
          summary: 'Il percorso completo backend + frontend, dall’entità EF Core fino alla pagina Vue.',
        },
        {
          file: 'guide/test-backend.md',
          title: 'Testare il backend',
          summary: 'Dominio con new, handler con NSubstitute, architettura con la reflection: che cosa si testa dove e come si scrive un test nuovo.',
        },
      ],
    },
    {
      title: 'Operatività',
      pages: [
        {
          file: 'deploy/render.md',
          title: 'Deploy su Render',
          summary: 'Pubblicare backend e frontend da GitHub: servizi, variabili, CORS, diagnostica.',
        },
      ],
    },
  ],
};

// ─── Markdown ────────────────────────────────────────────────────────────────

const md = new MarkdownIt({
  html: true,
  linkify: true,
  highlight(code, lang) {
    // vue/env non sono lingue di highlight.js: si appoggiano alla più vicina.
    const alias = { vue: 'xml', env: 'ini', text: 'plaintext', sh: 'bash' };
    const language = alias[lang] || lang;
    if (language && hljs.getLanguage(language)) {
      try {
        return hljs.highlight(code, { language, ignoreIllegals: true }).value;
      } catch {
        /* cade nel default */
      }
    }
    return md.utils.escapeHtml(code);
  },
});

// I link tra documenti sono scritti in Markdown (foo.md): qui diventano foo.html.
md.renderer.rules.link_open = (tokens, idx, options, _env, self) => {
  const href = tokens[idx].attrGet('href');
  if (href && !/^(https?:|mailto:|#)/.test(href)) {
    tokens[idx].attrSet('href', href.replace(/\.md(#|$)/, '.html$1'));
  } else if (href && /^https?:/.test(href)) {
    tokens[idx].attrSet('target', '_blank');
    tokens[idx].attrSet('rel', 'noopener');
  }
  return self.renderToken(tokens, idx, options);
};

// Le tabelle larghe devono scorrere dentro il proprio contenitore, non allargare la pagina.
md.renderer.rules.table_open = () => '<div class="table-wrap">\n<table>\n';
md.renderer.rules.table_close = () => '</table>\n</div>\n';

const slug = (s) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // toglie gli accenti: "Perché" → "perche"
    .replace(/`|\*|\(|\)|\[|\]|\./g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

// Aggiunge un id a ogni titolo e raccoglie l'indice della pagina (h2 + h3).
function headingsPlugin(mdi, toc) {
  const used = new Map();
  mdi.core.ruler.push('collect_headings', (state) => {
    for (let i = 0; i < state.tokens.length; i++) {
      const token = state.tokens[i];
      if (token.type !== 'heading_open') continue;

      const text = state.tokens[i + 1].content;
      let id = slug(text);
      if (used.has(id)) {
        const n = used.get(id) + 1;
        used.set(id, n);
        id = `${id}-${n}`;
      } else {
        used.set(id, 1);
      }
      token.attrSet('id', id);

      if (token.tag === 'h2' || token.tag === 'h3') {
        toc.push({ level: Number(token.tag[1]), text, id });
      }
    }
  });
}

// ─── Template ────────────────────────────────────────────────────────────────

const esc = (s) => md.utils.escapeHtml(s);

function navHtml(currentFile) {
  const depth = currentFile ? currentFile.split('/').length - 1 : 0;
  const up = depth === 0 ? '' : '../'.repeat(depth);

  const sections = SITE.sections
    .map((section) => {
      const items = section.pages
        .map((page) => {
          const isCurrent = page.file === currentFile;
          const href = `${up}${page.file.replace(/\.md$/, '.html')}`;
          return `<li><a href="${href}"${isCurrent ? ' aria-current="page"' : ''}>${esc(page.title)}</a></li>`;
        })
        .join('\n            ');
      return `<div class="nav-group">
          <p class="nav-title">${esc(section.title)}</p>
          <ul>
            ${items}
          </ul>
        </div>`;
    })
    .join('\n        ');

  return `<a class="nav-home" href="${up}index.html">Indice</a>
        <div class="search">
          <input type="search" class="search-input" placeholder="Cerca…" aria-label="Cerca nella documentazione" autocomplete="off">
          <ul class="search-results" hidden></ul>
        </div>
        ${sections}`;
}

// ─── Ricerca ─────────────────────────────────────────────────────────────────
//
// L'indice è un file JS (non JSON) perché così funziona anche aprendo gli .html da
// disco, dove fetch() di un file locale è bloccato. Ogni voce è una sezione (h2/h3)
// di una pagina, con il testo ridotto a plain text: la ricerca porta direttamente
// all'ancora giusta.

const stripHtml = (html) =>
  html
    .replace(/<pre[\s\S]*?<\/pre>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();

function indexEntries(page, body) {
  const url = page.file.replace(/\.md$/, '.html');
  const entries = [];
  // Spezza sul tag di apertura degli h2/h3: il primo pezzo è l'introduzione.
  const parts = body.split(/(?=<h[23] id=")/);
  for (const part of parts) {
    const m = part.match(/^<h([23]) id="([^"]+)">([\s\S]*?)<\/h\1>/);
    const id = m ? m[2] : '';
    const heading = m ? stripHtml(m[3]) : '';
    const text = stripHtml(m ? part.slice(m[0].length) : part).slice(0, 1500);
    if (!heading && !text) continue;
    entries.push({ p: page.title, s: heading, u: id ? `${url}#${id}` : url, x: text });
  }
  return entries;
}

const SEARCH_SCRIPT = `
(function () {
  var input = document.querySelector('.search-input');
  var list = document.querySelector('.search-results');
  if (!input || !list || !window.SEARCH_INDEX) return;
  var up = document.body.getAttribute('data-up') || '';

  function norm(s) { return s.toLowerCase().normalize('NFD').replace(/[\\u0300-\\u036f]/g, ''); }
  function esc(s) { return s.replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function mark(text, words) {
    var out = esc(text);
    words.forEach(function (w) {
      out = out.replace(new RegExp('(' + w.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&') + ')', 'ig'), '<mark>$1</mark>');
    });
    return out;
  }
  function snippet(text, words) {
    var low = norm(text), pos = -1;
    for (var i = 0; i < words.length && pos < 0; i++) pos = low.indexOf(words[i]);
    var start = Math.max(0, pos - 60), end = Math.min(text.length, (pos < 0 ? 0 : pos) + 120);
    return (start > 0 ? '… ' : '') + mark(text.slice(start, end), words) + (end < text.length ? ' …' : '');
  }

  function search(q) {
    var words = norm(q).split(/\\s+/).filter(function (w) { return w.length >= 2; });
    if (!words.length) return [];
    var hits = [];
    window.SEARCH_INDEX.forEach(function (e) {
      var p = norm(e.p), s = norm(e.s), x = norm(e.x), score = 0;
      for (var i = 0; i < words.length; i++) {
        var w = words[i];
        if (p.indexOf(w) >= 0) score += 5;
        else if (s.indexOf(w) >= 0) score += 3;
        else if (x.indexOf(w) >= 0) score += 1;
        else return;   // ogni parola deve comparire da qualche parte
      }
      hits.push({ e: e, score: score });
    });
    hits.sort(function (a, b) { return b.score - a.score; });
    return hits.slice(0, 8).map(function (h) { return h.e; }).map(function (e) {
      var title = e.s ? e.p + ' › ' + e.s : e.p;
      return { title: mark(title, words), url: up + e.u, text: snippet(e.x, words) };
    });
  }

  function render(results, q) {
    if (!q) { list.hidden = true; list.innerHTML = ''; return; }
    list.hidden = false;
    if (!results.length) { list.innerHTML = '<li class="search-empty">Nessun risultato</li>'; return; }
    list.innerHTML = results.map(function (r) {
      return '<li><a href="' + r.url + '"><span class="search-title">' + r.title + '</span><span class="search-snippet">' + r.text + '</span></a></li>';
    }).join('');
  }

  var timer = null;
  input.addEventListener('input', function () {
    clearTimeout(timer);
    var q = input.value.trim();
    timer = setTimeout(function () { render(search(q), q); }, 80);
  });
  input.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape') { input.value = ''; render([], ''); }
    if (ev.key === 'Enter') { var first = list.querySelector('a'); if (first) first.click(); }
  });
})();
`;

function tocHtml(toc) {
  if (toc.length < 3) return '';
  // Il testo del titolo è markdown grezzo: `Foo` deve restare codice, non backtick a video.
  const label = (text) => esc(text).replace(/`([^`]+)`/g, '<code>$1</code>');
  const items = toc
    .map((h) => `<li class="lvl-${h.level}"><a href="#${h.id}">${label(h.text)}</a></li>`)
    .join('\n          ');
  return `<nav class="toc" aria-label="Indice della pagina">
        <p class="toc-title">In questa pagina</p>
        <ul>
          ${items}
        </ul>
      </nav>`;
}

function layout({ title, section, body, currentFile }) {
  const depth = currentFile ? currentFile.split('/').length - 1 : 0;
  const up = depth === 0 ? '' : '../'.repeat(depth);
  const pageTitle = title === SITE.title ? SITE.title : `${title} — ${SITE.title}`;

  const version = SITE.templateVersion
    ? `<p class="footer-version">Descrive il template <strong>${esc(SITE.title)}</strong> alla versione ${esc(SITE.templateVersion)}.</p>`
    : '';

  return `<!DOCTYPE html>
<html lang="it">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(pageTitle)}</title>
  <link rel="stylesheet" href="${up}assets/style.css">
</head>
<body data-up="${up}">
  <header class="topbar">
    <a class="brand" href="${up}index.html">
      <span class="brand-name">${esc(SITE.title)}</span>
      <span class="brand-sub">${esc(SITE.subtitle)}</span>
    </a>
  </header>

  <div class="shell">
    <input type="checkbox" id="nav-toggle" class="nav-toggle">
    <label for="nav-toggle" class="nav-toggle-label">Sezioni</label>

    <nav class="sidebar" aria-label="Navigazione">
        ${navHtml(currentFile)}
    </nav>

    <main>
      ${section ? `<p class="eyebrow">${esc(section)}</p>` : ''}
      <article class="prose">
${body}
      </article>
    </main>
  </div>

  <footer class="footer">
    <p>Documentazione del template <strong>app-boilerplate</strong>. Le pagine sono generate dai file Markdown in <code>docs/</code>: modificare il <code>.md</code>, non l’HTML.</p>
    ${version}
  </footer>

  <script src="${up}assets/search-index.js"></script>
  <script>${SEARCH_SCRIPT}</script>
</body>
</html>
`;
}

// La home ricava le schede dalla stessa struttura della barra laterale.
function homeCards() {
  return SITE.sections
    .map((section) => {
      const cards = section.pages
        .map(
          (page) => `      <a class="card" href="${page.file.replace(/\.md$/, '.html')}">
        <h3>${esc(page.title)}</h3>
        <p>${esc(page.summary)}</p>
      </a>`,
        )
        .join('\n');
      return `  <section class="home-section">
    <h2>${esc(section.title)}</h2>
    <div class="card-grid">
${cards}
    </div>
  </section>`;
    })
    .join('\n');
}

// ─── Build ───────────────────────────────────────────────────────────────────

const pages = [
  { file: 'index.md', title: SITE.title, section: null },
  ...SITE.sections.flatMap((s) => s.pages.map((p) => ({ ...p, section: s.title }))),
];

async function clean() {
  let removed = 0;
  for (const page of pages) {
    const out = path.join(DOCS, page.file.replace(/\.md$/, '.html'));
    await fs.rm(out, { force: true });
    removed++;
  }
  await fs.rm(path.join(DOCS, 'assets', 'search-index.js'), { force: true });
  console.log(`Rimossi ${removed} file HTML generati.`);
}

async function build() {
  let missing = 0;
  const searchIndex = [];
  for (const page of pages) {
    const src = path.join(DOCS, page.file);
    let raw;
    try {
      raw = await fs.readFile(src, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') {
        console.warn(`  ⚠ ${page.file} — file mancante, pagina saltata`);
        missing++;
        continue;
      }
      throw err;
    }

    const toc = [];
    const renderer = new MarkdownIt(md.options);
    renderer.renderer.rules.link_open = md.renderer.rules.link_open;
    renderer.renderer.rules.table_open = md.renderer.rules.table_open;
    renderer.renderer.rules.table_close = md.renderer.rules.table_close;
    headingsPlugin(renderer, toc);

    let body = renderer.render(raw);

    if (page.file !== 'index.md') searchIndex.push(...indexEntries(page, body));

    if (page.file === 'index.md') {
      body = body.replace('<!--CARDS-->', homeCards());
    } else {
      // L'indice va sotto il titolo, non sopra: replace() sostituisce solo la prima occorrenza.
      const nav = tocHtml(toc);
      if (nav) body = body.replace('</h1>', `</h1>\n${nav}`);
    }

    const html = layout({
      title: page.title,
      section: page.section,
      body,
      currentFile: page.file,
    });

    const out = path.join(DOCS, page.file.replace(/\.md$/, '.html'));
    await fs.mkdir(path.dirname(out), { recursive: true });
    await fs.writeFile(out, html, 'utf8');
    console.log(`  ${page.file}  →  ${path.relative(ROOT, out).replace(/\\/g, '/')}`);
  }

  const indexOut = path.join(DOCS, 'assets', 'search-index.js');
  await fs.writeFile(indexOut, `window.SEARCH_INDEX = ${JSON.stringify(searchIndex)};\n`, 'utf8');
  console.log(`  indice di ricerca: ${searchIndex.length} sezioni  →  docs/assets/search-index.js`);

  console.log(`\n${pages.length - missing} pagine generate${missing ? `, ${missing} saltate (file mancanti)` : ''}.`);
}

if (process.argv.includes('--clean')) await clean();
else await build();
