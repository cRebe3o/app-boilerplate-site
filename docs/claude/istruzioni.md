# Le istruzioni

Il secondo dei [tre livelli di garanzia](come-lavora.md#tre-livelli-di-garanzia) è fatto di testo:
i `CLAUDE.md`, le skill, i comandi. Questa pagina spiega che cosa contiene ciascun file, quando
Claude lo legge e, soprattutto, **dove va scritta una regola nuova**: è la decisione che, presa
male, riempie il progetto di istruzioni duplicate e contraddittorie.

## Che cosa legge Claude, e quando

| File | Che cosa contiene | Quando si carica | Stato |
|---|---|---|---|
| `CLAUDE.md` di root | **Come si lavora**: il ciclo, la definizione di "fatto", quando usare plan mode e reviewer, git, che cosa non si fa mai | All'avvio di ogni sessione aperta nella root del monorepo | presente |
| `apps/backend/CLAUDE.md` | **Com'è fatto il backend**: struttura della soluzione, regola delle dipendenze, aggregati, slice, persistenza, errori, auth, audit, test | Quando Claude legge file sotto `apps/backend/` | presente |
| `apps/frontend/CLAUDE.md` | **Com'è fatto il frontend**: struttura, tipi generati, flusso di una feature, store e pagine tipo, router, i18n, permessi, verifica | Quando Claude legge file sotto `apps/frontend/` | presente |
| `.claude/skills/*/SKILL.md` | **Procedure** per un compito preciso | Quando la richiesta corrisponde alla `description` della skill | presente |
| `.claude/skills/*/SKILL.md` con `disable-model-invocation: true` | **Comandi**: flussi completi che combinano più skill | Solo quando li invochi (`/new-feature`, `/fix`, …) | presente |
| `.claude/agents/*.md` | **Prompt dei reviewer** | Quando il lead chiama il subagente | in arrivo |

Due conseguenze pratiche:

- **Il `CLAUDE.md` di root è l'unico sempre presente.** Tutto ciò che deve valere in ogni sessione,
  qualunque cartella si tocchi, sta lì: il ciclo, la verifica, git, i segreti, il codice
  generato, i messaggi di commit. È la versione operativa delle
  [regole che valgono sempre](come-lavora.md#le-regole-che-valgono-sempre).
- **I `CLAUDE.md` di backend e frontend arrivano solo quando servono.** Una sessione che tocca solo
  il frontend non paga il costo delle 330 righe del backend, e viceversa.

## Com'è fatto un `CLAUDE.md` di cartella

I due file esistenti seguono la stessa forma, che conviene mantenere:

1. **La struttura**: le cartelle e che cosa contengono, così Claude sa dove guardare e dove
   scrivere.
2. **Le regole, con il perché.** "Le query usano `IReadDbContext`" è una regola; "perché le letture
   non passano dai repository: proiettano direttamente nei DTO" è ciò che permette a Claude di
   applicarla bene in un caso che la regola non prevede.
3. **Un esempio tipo** per le forme che si ripetono: lo store di una lista paginata, la pagina
   lista, la slice di un comando. Un esempio vale più di un paragrafo di descrizione.
4. **La verifica**: i comandi che dicono se la modifica è giusta.
5. **Le note per Claude**: le regole più facili da violare, in forma di elenco breve, in fondo.

Le **note per Claude** sono un promemoria, non il posto dove una regola è definita: ogni voce
riassume qualcosa che è spiegato sopra, nello stesso file. Se una nota non ha una sezione che la
spiega, va scritta prima la sezione.

## Dove va una regola nuova

È la domanda da farsi ogni volta che una convenzione nasce o cambia. Si parte dall'alto e ci si
ferma alla prima risposta "sì":

| Domanda | Se sì |
|---|---|
| Si può verificare in modo automatico? (un test di architettura, una regola ESLint, un hook, un controllo in CI) | **Si scrive lì**, e non serve un'istruzione. Vedi [Permessi e hook](permessi-e-hook.md) |
| Vale **sempre**, in qualsiasi parte del monorepo? (git, verifica, segreti) | `CLAUDE.md` di root |
| Descrive **com'è fatto** il codice di un'app? (un layer, un pattern, una convenzione di nomi) | Il `CLAUDE.md` di quella app |
| Descrive **come si fa** un compito preciso, passo per passo? (una slice, una pagina, un test) | Una skill |
| È una **sequenza di compiti** che si ripete e che ha conseguenze? (crea file, genera migration) | Un comando, che richiama le skill |
| È un **giudizio** che non si riesce a scrivere come regola? | La checklist di un reviewer |

Un esempio. "Ogni modifica al modello richiede due migration" sta oggi nel `CLAUDE.md` del backend
e nella skill `db-entity`. Ma è verificabile: la CI confronta il modello con le migration di
entrambi i provider *(in arrivo)*. Quando quel controllo esiste, l'istruzione resta solo come
spiegazione del *perché* servono due migration, non come regola da ricordare.

## Una regola in un solo posto

Se la stessa regola è scritta in tre file, prima o poi uno resta indietro e Claude riceve
istruzioni contraddittorie, senza modo di sapere quale sia quella giusta. Per questo:

- **la regola si definisce in un solo posto**, quello indicato dalla tabella sopra;
- **gli altri file rimandano**: una skill dice "segui le regole sugli store in
  `apps/frontend/CLAUDE.md`" invece di ricopiarle;
- **una skill può ripetere un esempio di codice**, perché le serve per scaffoldare, ma l'esempio
  deve compilare con le regole del `CLAUDE.md`, non introdurne di nuove.

Quando cambi una convenzione, cerca dove è citata (`grep` sul nome del metodo o del pattern in
`apps/*/CLAUDE.md` e `.claude/`) e aggiorna tutti i rimandi nello stesso commit.

## Scrivere istruzioni che funzionano

- **Concrete, non generiche.** "Scrivi codice pulito" non cambia nulla. "Nessuna chiamata `axios`
  fuori dai service" cambia il codice che Claude scrive.
- **Con il perché.** Una regola senza ragione viene applicata alla lettera anche dove non ha
  senso, o ignorata dove sembra di troppo.
- **Con il caso di riferimento.** "Come `Groups`" o "come `users.store.ts`" porta Claude a leggere
  codice vero, che è sempre aggiornato più di qualsiasi descrizione.
- **Corte.** Un `CLAUDE.md` si legge per intero a ogni caricamento: ciò che è raro o lungo sta
  meglio in una skill, che si carica solo quando serve.
- **Verificate.** Un'istruzione nuova si prova chiedendo a Claude il compito che dovrebbe
  governare, in una sessione pulita, e guardando se il risultato la rispetta.

## Le istruzioni nei progetti generati

I `CLAUDE.md`, le skill e i comandi arrivano dal template e si aggiornano con
[`copier update`](../progetto/generazione.md#aggiornare-un-progetto-quando-il-template-cambia),
come il resto del codice. Un progetto può aggiungere le sue regole, ma conviene farlo **in fondo ai
file, in una sezione propria**, o in skill con un nome nuovo: così un aggiornamento del template
produce meno conflitti.

Una regola nata in un progetto che vale per tutti torna al template per la strada descritta in
[Contribuire al template](../progetto/contribuire.md).

## Da qui

- **[Le skill e i comandi](skill.md)** — l'elenco di ciò che il template include
- **[Permessi e hook](permessi-e-hook.md)** — il livello deterministico, dove le regole non
  dipendono dalla lettura
- **[Il modello di lavoro](come-lavora.md)** — i tre livelli di garanzia
