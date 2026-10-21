# I subagenti

Il [modello di lavoro](come-lavora.md) stabilisce che i subagenti **guardano e cercano, ma non
scrivono**. Questa pagina spiega come lavorano in concreto: chi li chiama, che cosa ricevono, che
cosa restituiscono, come sono definiti e che cosa succede alle loro segnalazioni.

> **Stato.** Explore e Plan sono integrati in Claude Code e si usano già. I due reviewer
> (`architecture-security-reviewer` ed `ef-sql-reviewer`) sono **in arrivo**: questa pagina è la
> loro specifica. Quando entrano nel template, i file descritti qui compaiono in `.claude/agents/`.

## Che cos'è un subagente

Un subagente è un'altra istanza di Claude che il lead avvia per un compito circoscritto. Ha tre
caratteristiche che ne decidono l'uso:

- **Parte a freddo.** Non vede la conversazione con te, né i file che il lead ha già letto, né le
  decisioni prese. Sa soltanto ciò che il lead gli scrive nella richiesta, più ciò che legge da
  solo.
- **Lavora in un contesto separato.** I file che apre e i tentativi che fa restano nel suo
  contesto. Al lead torna solo il rapporto finale. È questo che lo rende utile: venti file letti
  da un subagente costano al lead una pagina di conclusioni, non venti file.
- **Risponde al lead, non a te.** Il rapporto lo legge il lead, che te ne riporta la sostanza. Per
  questo il lead, chiudendo, ti dice sempre quali segnalazioni ha applicato e quali ha scartato.

Da qui vengono le due regole che seguono: la **richiesta** deve contenere tutto ciò che serve, e
il **rapporto** deve avere un formato che il lead possa valutare punto per punto.

## I subagenti del progetto

| Subagente | Tipo | Modello | Strumenti | Compito | Stato |
|---|---|---|---|---|---|
| **Explore** | integrato | quello predefinito | sola lettura | Ricerca a ventaglio: trova dove sta qualcosa e restituisce la conclusione | presente |
| **Plan** | integrato | quello del lead | sola lettura | Critica un piano già scritto: file dimenticati, rischi, alternative più semplici | presente |
| **architecture-security-reviewer** | del progetto | Sonnet | `Read`, `Grep`, `Glob` | Permessi, posto delle regole di business, dati esposti, aderenza all'architettura | in arrivo |
| **ef-sql-reviewer** | del progetto | Sonnet | `Read`, `Grep`, `Glob` | Query, mapping, migration e differenze fra SQL Server e PostgreSQL | in arrivo |

Che cosa guarda ciascun reviewer, e che cosa lascia ai test, è descritto in
[I reviewer](come-lavora.md#i-reviewer).

## Una chiamata, dall'inizio alla fine

```
Lead                                   Subagente
 │
 ├── scrive la richiesta  ───────────►  legge il CLAUDE.md del progetto
 │   obiettivo, file, diff,             legge i file indicati e quelli vicini
 │   che cosa guardare                  confronta con le regole
 │                                               │
 │   ◄───────────────────────────────── rapporto in formato fisso
 │
 ├── valuta ogni segnalazione
 │     corretta     → corregge
 │     non corretta → scarta, con la ragione
 │
 └── verifica di nuovo (build, test, lint, typecheck)
```

Il subagente non modifica nulla e non lancia comandi. Ogni correzione la fa il lead, e passa dalla
stessa verifica di qualsiasi altra modifica.

## La richiesta: che cosa passa il lead

Siccome il subagente parte a freddo, una richiesta vaga produce una review vaga. Il lead scrive
sempre:

| Che cosa | Perché |
|---|---|
| **L'obiettivo della modifica**, in una o due frasi | Senza, il reviewer giudica il codice ma non sa se fa ciò che deve |
| **Le decisioni già prese con te** (es. "hard delete, confermato") | Altrimenti il reviewer le ripropone come problemi |
| **L'elenco dei file** creati e modificati | Delimita il perimetro: il reviewer non rilegge tutto il progetto |
| **Il diff** delle parti di sua competenza | Il reviewer non ha `git`: il diff gli arriva nella richiesta |
| **Che cosa guardare in particolare**, se c'è | "La tabella `Suppliers` in produzione ha già 40.000 righe" cambia il giudizio su una migration |

Un esempio, per l'anagrafica fornitori:

```text
Revisiona la parte dati di una nuova entità Supplier (anagrafica fornitori).

Obiettivo: CRUD fornitori con lista paginata lato server e ricerca su ragione sociale
e partita IVA. La partita IVA è univoca (confermato dall'utente). Hard delete.

File:
- Domain/Suppliers/Supplier.cs (nuovo)
- Infrastructure/Persistence/Configurations/SupplierConfiguration.cs (nuovo)
- Infrastructure/Migrations/SqlServer/…_AddSuppliers.cs (nuovo)
- Infrastructure/Migrations/PostgreSql/…_AddSuppliers.cs (nuovo)
- Application/Suppliers/GetSuppliers/GetSuppliersQueryHandler.cs (nuovo)

Diff: <diff dei file sopra>

Attenzione in particolare a: la ricerca deve comportarsi allo stesso modo sui due provider.
```

## Il rapporto: che cosa restituiscono

I reviewer rispondono sempre nello stesso formato, perché il lead deve poter decidere segnalazione
per segnalazione:

```text
[ALTA] Application/Suppliers/GetSuppliers/GetSuppliersQueryHandler.cs:34
Problema: la ricerca usa Contains sulla ragione sociale. Su PostgreSQL il confronto
è case-sensitive, su SQL Server (collation predefinita) no: la stessa ricerca dà
risultati diversi.
Correzione: normalizzare il maiuscolo/minuscolo su entrambi i lati del confronto,
così il risultato non dipende dal provider.

[BASSA] Infrastructure/Persistence/Configurations/SupplierConfiguration.cs:21
Problema: Email senza HasMaxLength: diventa nvarchar(max) / text.
Correzione: HasMaxLength(256), come User.Email.

Non verificato: l'indice univoco sulla partita IVA in presenza di righe esistenti,
perché la tabella è nuova.
```

| Severità | Significato | Che cosa ne fa il lead |
|---|---|---|
| **ALTA** | Un bug, una falla di sicurezza, una migration che perde dati | Corregge prima di chiudere, o ti spiega perché non è un problema |
| **MEDIA** | Funziona, ma viola una convenzione o crea un problema prevedibile | Corregge, salvo una ragione esplicita |
| **BASSA** | Miglioria, coerenza con il resto del codice | Valuta; può proportela invece di applicarla |

Due regole del formato:

- **Se non trova problemi lo dice**, con una riga: "Nessun problema nel perimetro indicato". Un
  reviewer che inventa segnalazioni per sembrare utile è peggio di nessun reviewer.
- **Dichiara che cosa non ha potuto verificare.** È la sezione *Non verificato*: dice al lead dove
  la review non arriva, invece di lasciar credere che tutto sia stato controllato.

## Come sono definiti

Ogni reviewer è un file Markdown in `.claude/agents/`, con un'intestazione che ne fissa nome,
strumenti e modello, e un corpo che è il suo prompt di sistema:

```markdown
---
name: ef-sql-reviewer
description: Revisiona entità, configuration, migration e query EF Core su SQL Server
  e PostgreSQL. Usalo dopo modifiche al modello dati o a query di lettura non banali.
tools: Read, Grep, Glob
model: sonnet
---

Sei un reviewer di accesso ai dati. Non modifichi file.

1. Leggi il CLAUDE.md di root e quello di apps/backend: descrivono l'architettura
   di QUESTO progetto. Non dare per scontata un'architettura diversa.
2. Leggi i file indicati nella richiesta e, se serve, quelli che usano o sono usati.
3. Controlla: …
4. Rispondi nel formato: [SEVERITÀ] file:riga / Problema / Correzione,
   poi "Non verificato". Se non ci sono problemi, dillo in una riga.
```

Tre scelte in questa intestazione:

- **`tools: Read, Grep, Glob`** — la sola lettura non è un'istruzione che il reviewer potrebbe
  ignorare: senza `Edit`, `Write` e `Bash` non ha proprio il modo di modificare qualcosa. È il
  [livello deterministico](come-lavora.md#tre-livelli-di-garanzia) applicato al reviewer stesso.
  Per lo stesso motivo il diff arriva nella richiesta invece di essere letto con `git diff`.
- **`model: sonnet`** — un compito circoscritto e ben descritto non ha bisogno del modello del
  lead. Sonnet ragiona abbastanza bene su architettura e SQL, ed è più rapido ed economico.
- **La `description`** dice *quando* usarlo. È ciò che il lead legge per decidere se chiamarlo, e
  deve essere coerente con la tabella in [Il ciclo di una modifica](ciclo-di-una-modifica.md#5-revisionare).

L'architettura **non sta nel prompt**: il reviewer la legge dal `CLAUDE.md`. Così lo stesso file
funziona su un progetto in Clean Architecture e su uno organizzato a vertical slice.

## In parallelo, e quando no

**In parallelo sì**, quando i compiti sono indipendenti e nessuno scrive:

- i due reviewer sulla stessa modifica, che tocca sia endpoint e permessi sia il modello dati: il
  lead li avvia insieme e ne raccoglie i rapporti;
- due o tre ricerche di Explore su domande diverse ("dove si usa `IsActive`?", "quali store usano
  ancora `run` per le scritture?").

**In parallelo no:**

- **mai per scrivere.** Vedi [il principio](come-lavora.md#il-principio-un-solo-autore).
- **mai una catena "review → correggi → review"** lasciata girare da sola. Dopo le correzioni il
  lead rilancia la verifica, non il reviewer. Lo richiama solo se le correzioni hanno cambiato il
  disegno (un'entità rimodellata, un permesso diverso), e in quel caso è una review nuova, con una
  richiesta nuova.

## Explore e Plan, in pratica

### Explore

Si usa quando la risposta richiede di **scorrere molti file** e al lead serve solo la conclusione.

| Explore sì | Explore no |
|---|---|
| "In quali pagine c'è una ricerca, e quali usano `useServerTable`?" | Leggere un file di cui si conosce il percorso |
| "Dove viene letto o scritto `Supplier.VatNumber`, backend e frontend?" | Cercare una classe per nome: basta una ricerca diretta |
| Capire una convenzione che cambia nome da una cartella all'altra | Leggere i file che si stanno per modificare: il lead deve averli davanti lui |

Nella richiesta il lead indica **quanto cercare a fondo** e **che forma deve avere la risposta**
(un elenco di file e righe, una tabella, un sì/no con le eccezioni).

### Plan

Si usa sulle modifiche grandi, **dopo** che il lead ha scritto un piano e **prima** di
presentartelo. Riceve il piano e i requisiti, e restituisce ciò che manca o che non torna: file
dimenticati (il `DataSeeder` per i permessi, `sections.config.ts` per il menu, le traduzioni),
migration con rischi, una strada più semplice. Il lead corregge il piano e ti porta la versione
corretta, dicendo che cosa è cambiato.

## Limiti e costi

- **Ogni chiamata riparte da zero.** Rilegge `CLAUDE.md` e codice: costa tempo e token. Per questo
  un reviewer si chiama quando la modifica tocca ciò che sa giudicare, non a ogni modifica.
- **Vede solo una parte.** Legge il perimetro che gli è stato dato e poco intorno. Può segnalare
  come problema una scelta che il contesto rende giusta: è il motivo per cui il lead valuta ogni
  segnalazione invece di applicarla.
- **Non è deterministico.** Due esecuzioni sullo stesso codice possono dare rapporti diversi. Un
  reviewer non sostituisce un test.
- **Se una segnalazione si ripete, va promossa.** Quando lo stesso problema torna in più review ed
  è esprimibile come test, regola ESLint o hook, si scrive lì, e si toglie dalla checklist del
  reviewer. È la regola dei [tre livelli](come-lavora.md#tre-livelli-di-garanzia) usata nel verso
  opposto.

## Aggiungere un subagente

Prima di aggiungerne uno, la domanda è se il controllo può stare a un livello più affidabile: un
test, un hook, una riga di `CLAUDE.md`. Molte proposte si fermano qui: vedi
[Le scelte scartate](come-lavora.md#le-scelte-scartate).

Se serve davvero, il nuovo subagente deve:

- avere un **compito circoscritto**, descrivibile in una frase nella `description`;
- essere in **sola lettura**, con `tools` che lo garantisce;
- giudicare qualcosa che **non si riesce a esprimere come test**;
- leggere l'architettura dal **`CLAUDE.md`**, non averla scritta nel prompt;
- rispondere nel **formato fisso** del rapporto.

**Come si prova.** Su un branch di prova si introducono di proposito i problemi che il subagente
deve trovare (un endpoint con il permesso sbagliato, una query N+1, una migration che elimina una
colonna piena) e si controlla che li segnali tutti. Poi lo si lancia su una modifica corretta, e si
controlla che risponda "nessun problema" invece di inventarne. Il subagente entra nel template
solo se supera entrambe le prove.

## Da qui

- **[Il modello di lavoro](come-lavora.md)** — perché i subagenti non scrivono, e i tre livelli di
  garanzia
- **[Il ciclo di una modifica](ciclo-di-una-modifica.md#5-revisionare)** — quando si chiama quale
  reviewer
- **[Le skill e i comandi](skill.md)** — le istruzioni che il lead segue mentre scrive
