// Generatore del sito di documentazione.
//
//   npm run build     genera un .html accanto a ogni .md descritto in SITE
//   npm run clean     rimuove gli .html generati
//
// I file Markdown in docs/ sono l'unica fonte: l'HTML è sempre derivato e non va
// modificato a mano. La struttura qui sotto genera la home, la barra laterale e
// l'ordine di lettura: aggiungere una pagina significa aggiungere una voce a SITE.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import MarkdownIt from 'markdown-it';
import hljs from 'highlight.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DOCS = path.join(ROOT, 'docs');

const SITE = {
  title: 'DelVoltone',
  subtitle: 'Documentazione tecnica',
  sections: [
    {
      title: 'Progetto',
      pages: [
        {
          file: 'progetto/panoramica.md',
          title: 'Panoramica',
          summary: 'Che cos’è DelVoltone, com’è fatto il monorepo, quali sono i domini e le convenzioni.',
        },
      ],
    },
    {
      title: 'Database',
      pages: [
        {
          file: 'database_sql-only/panoramica.md',
          title: 'Panoramica',
          summary: 'Un’app, due provider SQL: che cosa significa e come si sceglie fra SQL Server e PostgreSQL.',
        },
        {
          file: 'database_sql-only/architettura.md',
          title: 'Architettura',
          summary: 'Un solo AppDbContext, il modello EF Core, lo schema relazionale, i due set di migration.',
        },
        {
          file: 'database_sql-only/implementazione.md',
          title: 'Implementazione',
          summary: 'Il codice: switch in DI, AppDbContext, handler su EF Core, migration, seed.',
        },
        {
          file: 'database_sql-only/decisioni.md',
          title: 'Decisioni',
          summary: 'Perché la chiave primaria è int identity, perché è caduto Mongo, che cosa è stato scartato.',
        },
      ],
    },
    {
      title: 'Database — versione storica (obsoleta)',
      pages: [
        {
          file: 'database_sql-mongo/panoramica.md',
          title: 'Panoramica (SQL + Mongo)',
          summary: 'OBSOLETO — la versione dual MongoDB/SQL Server, sostituita a luglio 2026.',
        },
        {
          file: 'database_sql-mongo/architettura.md',
          title: 'Architettura (SQL + Mongo)',
          summary: 'OBSOLETO — il seam dei repository e il modello dati condiviso Mongo/SQL.',
        },
        {
          file: 'database_sql-mongo/implementazione.md',
          title: 'Implementazione (SQL + Mongo)',
          summary: 'OBSOLETO — i due repository a confronto, conversioni ObjectId, transazioni.',
        },
        {
          file: 'database_sql-mongo/decisioni.md',
          title: 'Decisioni (SQL + Mongo)',
          summary: 'OBSOLETO — perché la chiave primaria era ObjectId nella versione dual-provider.',
        },
      ],
    },
    {
      title: 'Autenticazione',
      pages: [
        {
          file: 'autenticazione/autenticazione.md',
          title: 'JWT e MSAL',
          summary: 'Le due strategie di accesso, i flussi, il codice e la risoluzione dei permessi.',
        },
        {
          file: 'autenticazione/azure-app-registration.md',
          title: 'App registration Azure',
          summary: 'Guida operativa: registrare SPA e API su Entra ID e configurare il progetto.',
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
        {
          file: 'guide/nuova-feature.md',
          title: 'Aggiungere una feature',
          summary: 'Il percorso completo backend + frontend, ricalcato su una slice che esiste davvero.',
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
        ${sections}`;
}

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

  return `<!DOCTYPE html>
<html lang="it">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(pageTitle)}</title>
  <link rel="stylesheet" href="${up}assets/style.css">
</head>
<body>
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
    <p>Documentazione del progetto <strong>DelVoltone</strong>. Le pagine sono generate dai file Markdown in <code>docs/</code>: modificare il <code>.md</code>, non l’HTML.</p>
  </footer>
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
  console.log(`Rimossi ${removed} file HTML generati.`);
}

async function build() {
  for (const page of pages) {
    const src = path.join(DOCS, page.file);
    const raw = await fs.readFile(src, 'utf8');

    const toc = [];
    const renderer = new MarkdownIt(md.options);
    renderer.renderer.rules.link_open = md.renderer.rules.link_open;
    renderer.renderer.rules.table_open = md.renderer.rules.table_open;
    renderer.renderer.rules.table_close = md.renderer.rules.table_close;
    headingsPlugin(renderer, toc);

    let body = renderer.render(raw);

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
  console.log(`\n${pages.length} pagine generate.`);
}

if (process.argv.includes('--clean')) await clean();
else await build();
