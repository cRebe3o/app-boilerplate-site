# Permessi e hook

Le istruzioni dicono a Claude che cosa *dovrebbe* fare. I permessi e gli hook decidono che cosa
*può* fare. Sono il [livello deterministico](come-lavora.md#tre-livelli-di-garanzia) applicato a
Claude stesso: non dipendono da una lettura, valgono a ogni chiamata.

Entrambi si configurano in `.claude/settings.json`, che è versionato con il progetto e vale per
tutti quelli che ci lavorano.

## I permessi

Ogni azione di Claude che esce dalla lettura dei file (lanciare un comando, modificare un file)
passa da un controllo dei permessi, con tre esiti:

| Esito | Che cosa succede |
|---|---|
| **allow** | Claude esegue senza chiedere |
| **ask** (il default) | Claude si ferma e ti chiede conferma |
| **deny** | Claude non può farlo, nemmeno se glielo confermi in quel momento |

### Che cosa è consentito oggi

Il `settings.json` del template consente senza conferma i comandi che servono al
[ciclo di una modifica](ciclo-di-una-modifica.md) e che non hanno effetti fuori dal progetto:

| Gruppo | Comandi | Perché |
|---|---|---|
| Build e test .NET | `dotnet build`, `test`, `restore`, `clean`, `list`, `add` | La verifica non deve chiedere conferma a ogni giro |
| Migration | `dotnet ef` | Generare le due migration fa parte di ogni modifica al modello |
| Frontend | `pnpm install`, `run`, `exec`, `eslint`, `vitest`, `vue-tsc`, `gen:api`, `outdated`, `--filter`; gli stessi via `npx` | Lint, typecheck, test e rigenerazione dei tipi |
| Git in lettura | `git status`, `git diff`, `git log` | Claude deve poter vedere che cosa è cambiato |
| Verifica | `pnpm verify`, `node scripts/verify.mjs` | È il comando che chiude ogni modifica |

Ogni regola c'è due volte, `Bash(...)` e `PowerShell(...)`: su Windows Claude usa spesso lo
strumento PowerShell, e una regola scritta solo per Bash non lo copre, quindi la richiesta di
conferma arriverebbe lo stesso.

**Che cosa resta su "ask"**, per scelta: tutto il resto, e in particolare **ogni git che scrive**
(`add`, `commit`, `push`, `checkout`, `reset`, …). È la regola
["Git lo usi tu"](come-lavora.md#le-regole-che-valgono-sempre) resa concreta: anche se Claude
provasse a committare di sua iniziativa, si fermerebbe davanti alla richiesta di conferma.

Due voci sono più larghe di quanto sembri, e vale la pena saperlo:

- **`dotnet ef`** comprende anche `database update` e `migrations remove`, che modificano il database
  locale o i file delle migration. Sul database di sviluppo è accettabile; per questo la stringa di
  connessione in uso sulla tua macchina deve puntare a un database di sviluppo, mai a uno condiviso.
- **`pnpm run` e `pnpm exec`** eseguono qualsiasi script o binario del progetto. Sono consentiti
  perché gli script del monorepo sono build, test e lint; chi aggiunge uno script con effetti
  esterni (un deploy, una pubblicazione) deve tenerlo presente.

### Le regole deny: i segreti

```json
{
  "permissions": {
    "deny": [
      "Read(**/appsettings.local.json)",
      "Edit(**/appsettings.local.json)",
      "Read(**/.env*.local)",
      "Edit(**/.env*.local)"
    ]
  }
}
```

Con queste righe Claude non può aprire quei file nemmeno per errore, ad esempio cercando una
chiave di configurazione, e non può farlo neanche con `cat` o `head` da shell: Claude Code
applica le regole `Read` anche ai comandi di lettura che riconosce. Le chiavi e la loro forma
restano documentate in `appsettings.local.json.example`, `.env.local.example` e
[Configurazione](../progetto/configurazione.md), che è ciò che serve per lavorarci.

### Le impostazioni personali

Ognuno può aggiungere permessi suoi in **`.claude/settings.local.json`**: ad esempio consentire
`docker compose` o uno strumento che usa solo lui. Il file è nel `.gitignore` del template,
quindi i permessi personali non finiscono nel repository.

## Gli hook

Un hook è un comando che Claude Code esegue **da sé** in un momento preciso, ad esempio prima o
dopo che Claude modifichi un file. Claude non lo decide e non può saltarlo. Gli script sono in
`.claude/hooks/`.

### Prima della modifica: i file che non si toccano

Prima di ogni `Edit` o `Write`, `protect-files.mjs` controlla il percorso del file e **blocca**
la modifica se è uno di questi:

| File | Perché | Che cosa fare invece |
|---|---|---|
| `apps/frontend/src/types/api.generated.ts` | È generato dallo schema OpenAPI | `pnpm gen:api` |
| una migration già committata | È già stata applicata, altrove o in produzione | Una migration nuova che corregge |
| `appsettings.local.json`, `.env*.local` | Contengono segreti | Documentare la chiave nel file `.example` |

Quando blocca, lo script spiega il motivo, e il motivo arriva a Claude: invece di un errore muto,
Claude legge "è generato, usa `pnpm gen:api`" e cambia strada.

Una migration è "già committata" se esiste nell'ultimo commit (`HEAD`). Una migration appena
generata nel lavoro in corso invece si può ancora correggere.

Lo stesso hook guarda anche i comandi **Bash e PowerShell**: se un comando nomina un file di
segreti (`Get-Content .env.local`, `copy … appsettings.local.json`) lo blocca. Le regole `deny`
coprono già `cat` e simili; questo copre il resto. I file `.example` restano liberi.

### Dopo la modifica: la formattazione

Dopo ogni `Edit` o `Write`, `format.mjs` formatta il file appena scritto:

| File | Strumento |
|---|---|
| `.ts`, `.vue` sotto `apps/frontend` | Prettier, poi ESLint con `--fix` |
| `.cs` sotto `apps/backend` | `dotnet format whitespace` sul solo file |

Così le differenze di stile non arrivano mai in review, e il diff contiene solo ciò che cambia
davvero. Ogni file costa circa due secondi.

Se ESLint trova un **errore** che non sa correggere da solo, l'hook lo riporta a Claude con riga e
regola, e Claude lo corregge subito. Gli avvisi, come `max-lines`, non fermano il lavoro.

Il codice del template è già tutto formattato con le stesse regole (`.prettierrc`, con
`arrowParens: "avoid"` per lasciare `x => …` senza parentesi): toccare un file esistente non
produce un diff di sola formattazione.

### Come si configurano

Gli hook stanno nello stesso `settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Edit|Write|MultiEdit|NotebookEdit|Bash|PowerShell",
        "hooks": [{ "type": "command", "command": "node",
                    "args": ["${CLAUDE_PROJECT_DIR}/.claude/hooks/protect-files.mjs"], "timeout": 10 }]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Edit|Write|MultiEdit",
        "hooks": [{ "type": "command", "command": "node",
                    "args": ["${CLAUDE_PROJECT_DIR}/.claude/hooks/format.mjs"], "timeout": 60 }]
      }
    ]
  }
}
```

Con `args` l'hook gira **senza shell**: Claude Code avvia `node` direttamente e gli passa il
percorso dello script. È ciò che lo fa funzionare uguale su Windows (con o senza Git Bash),
macOS e Linux, e Node c'è già per il frontend.

Lo script riceve su stdin un JSON con lo strumento chiamato e i suoi argomenti, fra cui il
percorso del file o il comando. Per bloccare esce con codice `2` e scrive il motivo su stderr;
con codice `0` la modifica procede. Se l'input è inatteso, lascia passare: un hook rotto non
deve fermare tutto il lavoro.

## La verifica: `pnpm verify`

Dalla root del monorepo, un comando esegue tutti i controlli che dicono se una modifica è
"fatta":

```bash
pnpm verify              # backend e frontend
pnpm verify --backend    # build e test .NET
pnpm verify --frontend   # typecheck, lint e test Vue
```

```
✓ backend · build (9.9s)
✓ backend · test (2.9s)
✓ frontend · typecheck (7.2s)
✗ frontend · lint (2.9s)
    src/stores/suppliers.store.ts:12:7 'x' is assigned a value but never used. (@typescript-eslint/no-unused-vars)
✓ frontend · test (4.6s)

Verifica: 1 passo fallito
```

Per i passi verdi stampa una riga; per quelli rossi solo le righe d'errore (il test che fallisce
con il messaggio dell'asserzione, l'errore di compilazione con file e riga). Se la build .NET
non compila, i test backend vengono saltati. È lo script `scripts/verify.mjs`, ed è lo stesso
comando che userà la CI.

## Da qui

- **[Il modello di lavoro](come-lavora.md)** — perché un controllo deterministico batte
  un'istruzione
- **[Le istruzioni](istruzioni.md)** — dove va una regola che non si riesce a rendere deterministica
- **[Configurazione](../progetto/configurazione.md)** — i file di segreti e le loro chiavi
