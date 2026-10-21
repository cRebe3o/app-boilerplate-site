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

### Che cosa manca: le regole deny *(proposta)*

Oggi il template non ha regole `deny`. La regola "i segreti non si leggono e non si scrivono" è
quindi solo un'istruzione. Il modo deterministico di farla rispettare è questo:

```json
{
  "permissions": {
    "deny": [
      "Read(./apps/backend/**/appsettings.local.json)",
      "Edit(./apps/backend/**/appsettings.local.json)",
      "Read(./apps/frontend/.env*.local)",
      "Edit(./apps/frontend/.env*.local)"
    ]
  }
}
```

Con queste righe Claude non può aprire quei file nemmeno per errore, ad esempio cercando una chiave
di configurazione. Le chiavi e la loro forma restano documentate in
[Configurazione](../progetto/configurazione.md), che è ciò che serve per lavorarci.

### Le impostazioni personali

Ognuno può aggiungere permessi suoi in **`.claude/settings.local.json`**: ad esempio consentire
`docker compose` o uno strumento che usa solo lui. Quel file è personale e non va committato.

> **Da sistemare nel template.** `.claude/settings.local.json` oggi non è nel `.gitignore` del
> template: va aggiunto, altrimenti i permessi personali di qualcuno finiscono nel repository e
> valgono per tutti.

## Gli hook *(in arrivo)*

Un hook è un comando che Claude Code esegue **da sé** in un momento preciso, ad esempio prima o
dopo che Claude modifichi un file. Claude non lo decide e non può saltarlo. Gli hook previsti sono
due, già elencati in [I controlli deterministici](come-lavora.md#i-controlli-deterministici).

### Prima della modifica: i file che non si toccano

Prima di ogni `Edit` o `Write`, uno script controlla il percorso del file e **blocca** la modifica
se è uno di questi:

| File | Perché | Che cosa fare invece |
|---|---|---|
| `apps/frontend/src/types/api.generated.ts` | È generato dallo schema OpenAPI | `pnpm gen:api` |
| una migration già committata | È già stata applicata, altrove o in produzione | Una migration nuova che corregge |
| `appsettings.local.json`, `.env*.local` | Contengono segreti | Documentare la chiave in [Configurazione](../progetto/configurazione.md) |

Quando blocca, lo script spiega il motivo, e il motivo arriva a Claude: invece di un errore muto,
Claude legge "è generato, usa `pnpm gen:api`" e cambia strada.

Una migration "già committata" si riconosce con git: se il file è tracciato e non è fra le
modifiche in corso, è committato. Una migration appena generata nel lavoro corrente invece si può
ancora correggere.

### Dopo la modifica: la formattazione

Dopo ogni `Edit` o `Write`, il file appena scritto viene formattato: Prettier ed ESLint con
correzione automatica sui `.ts` e `.vue`, `dotnet format` sui `.cs`. Così le differenze di stile non
arrivano mai in review, e il diff contiene solo ciò che cambia davvero.

### Come si configurano

Gli hook stanno nello stesso `settings.json`, e gli script in `.claude/hooks/`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [{ "type": "command", "command": "node .claude/hooks/protect-files.mjs" }]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [{ "type": "command", "command": "node .claude/hooks/format.mjs" }]
      }
    ]
  }
}
```

Lo script riceve su stdin un JSON con lo strumento chiamato e i suoi argomenti, fra cui il percorso
del file. Per bloccare esce con codice `2` e scrive il motivo su stderr; con codice `0` la modifica
procede.

Gli script sono in Node, non in PowerShell o bash, perché devono funzionare uguale su Windows,
macOS e Linux, e Node c'è già per il frontend.

## Da qui

- **[Il modello di lavoro](come-lavora.md)** — perché un controllo deterministico batte
  un'istruzione
- **[Le istruzioni](istruzioni.md)** — dove va una regola che non si riesce a rendere deterministica
- **[Configurazione](../progetto/configurazione.md)** — i file di segreti e le loro chiavi
