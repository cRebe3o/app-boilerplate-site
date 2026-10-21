# Il modello di lavoro

Questa pagina descrive **come Claude Code lavora su un progetto generato dal template**: chi fa che
cosa, quali strumenti entrano in gioco, quali garanzie danno e perché l'organizzazione è questa e
non un'altra.

Non è un manuale di Claude Code. È la parte che il manuale non può dire: le scelte fatte *per
questi progetti* — una Clean Architecture .NET con doppio provider e un frontend Vue generato dai
tipi OpenAPI — e le ragioni dietro ciascuna.

> **Stato.** Questa pagina è la specifica dell'organizzazione, e una parte di ciò che descrive
> è ancora in introduzione nel template. Nelle tabelle la colonna **Stato** distingue ciò che c'è
> già (**presente**) da ciò che sta arrivando (**in arrivo**). Quando un pezzo entra nel template,
> la sua riga cambia qui.

## Il principio: un solo autore

Su un progetto lavora **un solo agente principale** — il *lead*, su Opus — che legge il codice,
pianifica, scrive le modifiche e decide. Tutto il codice che finisce in un commit passa dalle sue
mani.

I subagenti esistono, ma con due soli compiti:

- **guardare con occhi indipendenti** — una review fatta da un contesto che non ha scritto il codice
  vede cose che l'autore non vede più;
- **cercare in largo** — quando rispondere a una domanda richiede di scorrere decine di file e al
  lead serve solo la conclusione, non i file.

Nessun subagente scrive codice. Le ragioni sono pratiche:

- **un subagente parte a freddo**: non ha la conversazione, non sa che cosa è stato deciso dieci
  minuti prima, rilegge ciò che il lead sapeva già. Delegare la scrittura costa contesto e produce
  codice che il lead deve comunque rileggere tutto;
- **due autori in parallelo si pestano i piedi**: una slice tocca Domain, Application,
  Infrastructure, Api e frontend insieme, e i punti di contatto (il `DataSeeder`, `IReadDbContext`,
  `sections.config.ts`, le traduzioni) sono proprio quelli dove due modifiche concorrenti
  confliggono;
- **la coerenza è il valore del template**: il codice aggiunto deve assomigliare a quello che c'è.
  Un solo autore che segue le stesse istruzioni la mantiene; tanti autori la diluiscono.

## Tre livelli di garanzia

Ogni regola del progetto può essere fatta rispettare in tre modi, con affidabilità molto diversa:

| Livello | Strumenti | Che cosa garantisce |
|---|---|---|
| **1. Deterministico** | test, `Architecture.Tests`, compilatore, `vue-tsc`, ESLint, hook, CI | Sempre, a ogni esecuzione, senza interpretazione. Se la regola è violata, qualcosa diventa rosso |
| **2. Istruzioni** | `CLAUDE.md`, skill, comandi | Che Claude *sappia* la regola e la applichi scrivendo. Funziona quasi sempre, ma è una lettura, non un controllo |
| **3. Giudizio** | i subagenti reviewer | Una seconda lettura che trova ciò che non si può esprimere come test: un permesso sbagliato, una query che diventa N+1, una regola di business nel posto sbagliato |

Da qui viene la regola che decide come si aggiunge un controllo nuovo:

> **Se una regola può essere un test o un hook, non diventa un'istruzione. Se può essere
> un'istruzione chiara, non diventa un agente.** Si scende di livello solo quando quello sopra non
> riesce a esprimerla.

Un esempio dal template. "Un handler non usa `AppDbContext`" potrebbe essere una voce della
checklist di review — ma è verificabile sugli assembly compilati, e infatti lo verifica
`Architecture.Tests`, che fa fallire la build. Nessun reviewer deve più ricordarselo. Invece "questo
endpoint richiede il permesso giusto" non è riducibile a un test: che `users.write` sia il permesso
corretto per *quella* operazione è un giudizio, ed è lì che serve il reviewer.

## I componenti

```
Claude lead (Opus)                    legge, pianifica, scrive, decide
│
├── Explore                           subagente integrato · ricerca in sola lettura
├── Plan mode / Plan                  integrato · piano prima di scrivere, critica del piano
│
├── architecture-security-reviewer    subagente · Sonnet · sola lettura
│                                     permessi, confini fra layer, dati esposti
├── ef-sql-reviewer                   subagente · Sonnet · sola lettura
│                                     query, mapping, migration sui due provider
│
├── Istruzioni                        CLAUDE.md (root, backend, frontend) · skill · comandi
│
└── Controlli deterministici          hook · pnpm verify · test · CI
```

### Il lead e gli strumenti integrati

| Componente | Che cosa fa | Quando entra | Stato |
|---|---|---|---|
| **Lead** (Opus) | Tutto il lavoro di scrittura e tutte le decisioni | Sempre | presente |
| **Explore** | Ricerca a ventaglio in sola lettura, restituisce la conclusione | Quando la risposta richiede di scorrere molti file o convenzioni di nomi diverse. Non per leggere un file noto | presente |
| **Plan mode** | Il lead esplora e propone un piano senza toccare file, finché non lo approvi | Modifiche non banali: più layer, modello dati, permessi (vedi [Il ciclo di una modifica](ciclo-di-una-modifica.md#2-pianificare)) | presente |
| **Plan** (subagente) | Critica un piano già scritto: file dimenticati, rischi, alternative | Modifiche grandi, dove un errore di piano costa ore | presente |

### I reviewer

Due subagenti, entrambi **in sola lettura** e su **Sonnet**: abbastanza capaci da ragionare su
architettura e SQL, più rapidi ed economici del lead per un compito circoscritto. Non modificano
file: restituiscono un elenco di problemi in formato fisso (file e riga, severità, correzione
proposta), e il lead decide che cosa farne. Come si chiamano, che cosa ricevono e come sono definiti è in
[I subagenti](subagenti.md).

| Reviewer | Che cosa guarda | Che cosa **non** guarda | Stato |
|---|---|---|---|
| **architecture-security-reviewer** | Che ogni endpoint abbia il permesso *giusto*; che le regole di business stiano nell'aggregato e non nell'handler; che nessun dato sensibile finisca in una response, in un log o in uno snapshot di audit; che la slice rispetti l'architettura descritta nel `CLAUDE.md` del progetto | La direzione delle dipendenze fra layer — la verificano i test di architettura | presente |
| **ef-sql-reviewer** | Query che diventano N+1 o caricano colonne inutili; indici mancanti sui filtri; mapping (lunghezze, delete behavior, conversioni); migration che non reggono su una tabella già piena; differenze fra SQL Server e PostgreSQL (`Contains` case-sensitive, tipi, default) | Che le due migration esistano e siano allineate al modello — lo verificherà la CI *(in arrivo)*; fino ad allora è nella checklist di `/review` | presente |

I reviewer **non conoscono l'architettura a memoria**: la leggono dal `CLAUDE.md` del progetto che
stanno revisionando. È ciò che permette di usarli sia sui progetti generati dal template (Clean
Architecture) sia su progetti con un'organizzazione diversa, come una vertical slice.

### Le istruzioni

Come si scrivono e dove va una regola nuova è in [Le istruzioni](istruzioni.md).

| Livello | Che cosa contiene | Quando si carica | Stato |
|---|---|---|---|
| `CLAUDE.md` di root | **Come si lavora**: il ciclo, la definizione di "fatto", quando usare plan mode e reviewer, le convenzioni di commit, che cosa non si fa mai | All'avvio di ogni sessione | presente |
| `apps/backend/CLAUDE.md`, `apps/frontend/CLAUDE.md` | **Com'è fatto il codice**: struttura, regole dei layer, convenzioni | Quando Claude legge file in quella cartella | presente |
| Skill (`.claude/skills/`) | **Procedure**: come si scrive una slice, un'entità, una pagina, un test | Da sole, quando la richiesta corrisponde alla loro descrizione | presente |
| Comandi (`/new-feature`, `/new-slice`, `/add-field`, `/remove-field`, `/fix`, `/review`) | **Flussi completi** che combinano più skill. Sono skill con `disable-model-invocation: true` | Solo quando li invochi tu | presenti |

La distinzione fra skill e comandi è voluta. Una skill si attiva da sola perché descrive *come* si
fa una cosa, e saperlo non fa mai danni. Un comando è un'azione con conseguenze — crea una dozzina
di file, genera migration — e parte solo se lo chiedi.

### I controlli deterministici

Permessi e hook, con la loro configurazione, sono descritti in [Permessi e hook](permessi-e-hook.md).

| Controllo | Che cosa fa | Stato |
|---|---|---|
| **Hook prima della modifica** | Bloccano le modifiche che non vanno mai fatte a mano: `api.generated.ts` (è generato), le migration già committate (si corregge con una migration nuova), `appsettings.local.json` e `.env*.local` (contengono segreti) | presente |
| **Hook dopo la modifica** | Formattano il file appena scritto (Prettier ed ESLint su ts e vue, `dotnet format` su C#), così le differenze di stile non arrivano mai in review | presente |
| **`pnpm verify`** | Build, test, lint e typecheck di backend e frontend in un comando, con un esito sintetico | presente |
| **Test** | Domain, Application e architettura; in arrivo i test di integrazione su un database vero, per **entrambi** i provider | presenti, integrazione in arrivo |
| **CI** | Gli stessi controlli di `verify` su ogni push, più due che in locale si dimenticano: migration mancanti rispetto al modello e tipi TypeScript non rigenerati dopo una modifica all'API | in arrivo |

## Le scelte scartate

Organizzazioni più ricche sono state considerate e scartate. Le ragioni restano scritte qui, così
la scelta non va ridiscussa ogni volta.

| Scartato | Perché |
|---|---|
| **Un subagente che lancia build e test** (es. su Haiku, "riporta solo l'esito") | Uno script con output sintetico fa lo stesso lavoro in modo deterministico, più in fretta e senza poter riassumere male un errore. Il lead deve comunque vedere l'errore per correggerlo |
| **Un subagente che confronta DTO .NET e tipi TypeScript** | I tipi non si scrivono: si generano dallo schema OpenAPI. Il rischio vero è dimenticarsi di rigenerarli: lo intercetterà la CI *(in arrivo)* confrontando i tipi committati con quelli rigenerati; fino ad allora è una voce della checklist di `/review` |
| **Un reviewer dedicato ai componenti Vue/Vuetify** | Le regole del frontend sono quasi tutte meccaniche (testi con `t()`, nessuna chiamata HTTP fuori dai service, dimensione dei componenti) e stanno meglio in ESLint. Il resto è una checklist di `/review` |
| **Un reviewer con l'architettura scritta dentro** (es. "vertical slice") | I progetti non hanno tutti la stessa architettura. Un reviewer che la legge dal `CLAUDE.md` funziona ovunque; uno che la conosce a memoria va riscritto per ogni progetto |
| **Più agenti che scrivono codice in parallelo** | Vedi [il principio](#il-principio-un-solo-autore): costa contesto, produce conflitti nei punti di contatto e diluisce la coerenza |
| **Un reviewer a ogni modifica** | La review ha un costo e un rumore. Si chiama quando la modifica tocca ciò che il reviewer sa giudicare — vedi [quando revisionare](ciclo-di-una-modifica.md#5-revisionare) |

## Le regole che valgono sempre

Indipendentemente dal compito:

- **"Fatto" significa verificato.** Una modifica è finita quando build, test, lint e typecheck sono
  verdi — non quando "dovrebbe funzionare". Se un controllo fallisce, lo si dice con l'output.
- **Una regola si scrive in un solo posto.** Se la stessa convenzione compare nel `CLAUDE.md`, in una
  skill e in un comando, prima o poi uno dei tre resta indietro e Claude riceve istruzioni
  contraddittorie. Gli altri posti rimandano a quello.
- **Il codice generato non si modifica a mano**: `api.generated.ts` si rigenera, una migration
  committata si corregge con una migration nuova.
- **I segreti non si toccano**: `appsettings.local.json` e `.env*.local` non si leggono e non si
  scrivono.
- **Git lo usi tu.** Branch, stage, commit, push, merge e tag li fai tu; Claude li fa solo quando
  glielo chiedi esplicitamente, e solo l'operazione chiesta. Può leggere lo stato del repository
  (`git status`, `git diff`, `git log`) per capire che cosa è cambiato.
- **Le decisioni che spettano a te restano tue**: un soft delete, il nome di un permesso, una
  migration che cancella dati. Claude chiede, invece di scegliere un default con conseguenze.

## Da qui

- **[Il ciclo di una modifica](ciclo-di-una-modifica.md)** — lo stesso modello visto in azione,
  passo per passo, con tre esempi
- **[Lavorare con Claude](lavorare-con-claude.md)** — lo stesso modello visto dal tuo lato
- **[I subagenti](subagenti.md)** — come lavorano Explore, Plan e i reviewer
- **[Le skill e i comandi](skill.md)** — le skill e i comandi inclusi nel template
- **[Clean Architecture](../architettura/clean-architecture.md)** — le regole che i test fanno
  rispettare da soli
