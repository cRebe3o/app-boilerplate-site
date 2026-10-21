# Il ciclo di una modifica

Il [modello di lavoro](come-lavora.md) dice chi fa che cosa. Questa pagina lo mostra in movimento:
i passi che una modifica attraversa da quando la chiedi a quando è committata, che cosa succede in
ciascuno e quali strumenti entrano in gioco.

```
 1. Capire  →  2. Pianificare  →  3. Implementare  →  4. Verificare  →  5. Revisionare  →  6. Chiudere
                   (se serve)          ↑    hook          │                (se serve)
                                       └──── se rosso ────┘
```

Non tutte le modifiche attraversano tutti i passi: correggere un'etichetta non ha bisogno di un
piano né di un reviewer. Ma la **verifica non si salta mai**, e il passo che si salta va saltato
per una ragione, non per fretta. In fondo alla pagina c'è [quando il ciclo si accorcia](#quando-il-ciclo-si-accorcia).

## 1. Capire

Prima di scrivere, il lead deve sapere **che cosa c'è già** e **che cosa è stato deciso**.

- Il `CLAUDE.md` di root è già caricato all'avvio: dice come si lavora. Quelli di
  `apps/backend` e `apps/frontend` si caricano quando Claude apre file in quelle cartelle: dicono
  com'è fatto il codice.
- Il lead legge i file che la modifica tocca **prima** di toccarli, e una feature esistente dello
  stesso tipo da usare come riferimento (`Groups` per una lookup, `Users` per un aggregato con M2M).
- Se rispondere richiede di scorrere molti file — "dove viene usato questo campo?", "quali pagine
  hanno una ricerca?" — la ricerca va a **Explore**, che restituisce la conclusione senza riempire il
  contesto del lead di file letti a metà.

**Le domande si fanno qui, non dopo.** Se la richiesta lascia aperta una decisione che spetta a
te, Claude la chiede prima di scrivere codice:

| Domanda tipica | Perché non la decide Claude |
|---|---|
| Hard o soft delete? | Il default è hard delete; il soft delete cambia query, indici e audit |
| Che permessi servono, e a quali ruoli vanno? | È una scelta di sicurezza, non di stile |
| La lista va paginata lato server? Con quali filtri? | Dipende dai volumi reali, che Claude non conosce |
| La migration elimina o trasforma dati esistenti? | È irreversibile in produzione |

Le domande con una risposta ovvia o deducibile dal codice non si fanno: si sceglie il default del
progetto e lo si dice.

## 2. Pianificare

Il **plan mode** è il passo in cui il lead esplora e scrive un piano senza toccare file. Il piano
diventa codice solo dopo la tua approvazione.

| Si pianifica | Non serve un piano |
|---|---|
| La modifica tocca **più layer** (es. Domain + Application + frontend) | Un fix confinato in un file |
| Cambia il **modello dati**: entità, colonne, relazioni, migration | Un testo, una traduzione, uno stile |
| Tocca **permessi o autenticazione** | Un test che manca |
| Non è chiaro **dove** va la logica (aggregato, domain service, handler) | Una modifica meccanica già descritta da un comando (`/add-field`) |
| Ci sono più strade ragionevoli e la scelta ha conseguenze | |

Un buon piano, in questi progetti, dice sempre:

- **i file** che crea e che modifica, layer per layer, dal centro verso l'esterno;
- **le migration**: quali, e se toccano dati esistenti;
- **i permessi**: nuovi, riusati, e a quali ruoli del seed vanno;
- **i test** che aggiunge: invarianti in `Domain.Tests`, handler in `Application.Tests`, store e
  pagine nel frontend;
- **le domande aperte**, se ne restano.

Per le modifiche grandi — una nuova area funzionale, un cambio al modello di autorizzazione — il
piano può passare dal subagente **Plan** prima di arrivare a te: un secondo contesto che lo critica
cercando file dimenticati, rischi e alternative più semplici.

## 3. Implementare

Il lead scrive il codice, seguendo il piano se c'è. Lo strumento giusto dipende dal compito:

| Compito | Strumento |
|---|---|
| Una nuova entità con il CRUD completo, dal database alla pagina | `/new-feature <Entità>` |
| Un nuovo caso d'uso su un'entità esistente (un'azione, una query, un report) | `/new-slice` *(in arrivo)* |
| Aggiungere o togliere un campo, propagandolo ovunque | `/add-field`, `/remove-field` |
| Un bug descritto a parole | `/fix` |
| Tutto il resto | Le skill, che si attivano da sole: `backend-slice`, `db-entity`, `vue-feature`, `pagination`, … |

L'ordine di scrittura segue le dipendenze, **dal centro verso l'esterno**: dominio, mapping e
migration, Application, Api, poi frontend. Ogni passo compila sopra il precedente, e un errore si
scopre vicino a dove è nato.

Durante la scrittura lavorano gli **[hook](permessi-e-hook.md#gli-hook)**: una modifica a un file generato, a una
migration committata o a un file di segreti viene bloccata con la ragione, e ogni file scritto
esce già formattato.

## 4. Verificare

**Una modifica è finita quando i controlli sono verdi**, non quando sembra giusta.

```bash
pnpm verify              # dalla root: build e test .NET, typecheck, lint e test Vue
pnpm verify --backend    # solo la parte .NET (--frontend: solo la parte Vue)
```

Un esito per passo e, per quelli rossi, solo le righe d'errore: vedi
[La verifica](permessi-e-hook.md#la-verifica-pnpm-verify).

Fa parte della verifica anche **scrivere i test** che la modifica richiede: un'invariante nuova ha
il suo test in `Domain.Tests`, un handler nuovo il suo in `Application.Tests` (vedi
[Testare il backend](../guide/test-backend.md)).

Se qualcosa è rosso, si torna al passo 3. Se resta rosso per una ragione che non dipende dalla
modifica — un test già rotto, un servizio non avviato — Claude lo dice con l'output, invece di
dichiarare finito.

## 5. Revisionare

La review ha due forme.

**`/review`** è la review generale: parte dal diff del branch rispetto a `main` e lo confronta con
le convenzioni del progetto, backend e frontend. Si usa a fine lavoro su qualsiasi modifica non
banale.

**I reviewer** sono la review specialistica, e si chiamano quando la modifica tocca ciò che sanno
giudicare *(in arrivo)*:

| La modifica tocca… | Reviewer |
|---|---|
| Endpoint nuovi o modificati, permessi, autenticazione, dati restituiti al client, snapshot di audit | `architecture-security-reviewer` |
| Una regola di business di cui non è ovvio il posto | `architecture-security-reviewer` |
| Entità, configuration, migration | `ef-sql-reviewer` |
| Query di lettura nuove o con filtri, ordinamenti, paginazione | `ef-sql-reviewer` |
| Solo frontend, testi, stili | nessuno: bastano `/review` e i controlli |

Quando la modifica tocca entrambe le aree, i due reviewer lavorano **in parallelo**: leggono soltanto,
quindi non si intralciano.

**Che cosa si fa con le segnalazioni.** Un reviewer è un secondo parere, non un'autorità. Il lead
legge ogni segnalazione e per ciascuna:

- se è corretta, **la corregge** e torna alla verifica;
- se non lo è, **la scarta dicendo perché** — un reviewer che legge solo una parte del codice può
  non vedere il contesto che rende giusta una scelta.

Ciò che non si fa è applicare le segnalazioni alla cieca.

## 6. Chiudere

Le operazioni git le fai **tu**. Claude si ferma con le modifiche nel working tree e ti consegna
ciò che serve per committarle:

- **il riepilogo** dei file creati e modificati, raggruppati per layer;
- **un messaggio di commit proposto**, in italiano e con il prefisso convenzionale (`feat:`,
  `fix:`, `refactor:`, `docs:`, `chore:`, `test:`), che dice *che cosa* cambia e, se non è ovvio,
  *perché*;
- se la modifica cambia il comportamento del **template**, la voce aggiunta al suo `CHANGELOG.md`.

Branch, commit, push, merge e tag Claude li esegue solo se glielo chiedi esplicitamente, e solo
l'operazione chiesta.

## Tre esempi

### Una nuova entità: i fornitori

> "Mi serve l'anagrafica fornitori: ragione sociale, partita IVA, email, attivo sì/no."

1. **Capire** — il lead apre `Groups` come riferimento e chiede ciò che non può dedurre: la lista
   va paginata? Con ricerca su quali campi? La partita IVA è univoca? Quali ruoli vedono e
   modificano i fornitori?
2. **Pianificare** — plan mode, perché tocca tutti i layer e il modello dati. Il piano elenca
   l'aggregato `Supplier` con l'unicità della partita IVA, la configuration con l'indice univoco,
   le due migration, le slice CRUD, i permessi `suppliers.read/write/delete`, la pagina con
   `pagination` e `search-filter`, i test.
3. **Implementare** — `/new-feature Supplier`, che combina `db-entity`, `backend-slice`,
   `permissions`, `vue-feature`, `vuetify-dialog-form`.
4. **Verificare** — tutti i controlli, più i test dell'aggregato e degli handler.
5. **Revisionare** — `/review`, poi i due reviewer in parallelo: c'è un'entità nuova con indice
   univoco (ef-sql) e ci sono endpoint e permessi nuovi (architecture-security).
6. **Chiudere** — messaggio proposto: `feat: anagrafica fornitori`.

### Un nuovo caso d'uso: disattivare un fornitore

> "Un fornitore disattivato non deve più comparire nei menu a tendina, ma resta nello storico."

1. **Capire** — esiste già `Supplier`. La domanda da fare è una: chi può disattivare?
2. **Pianificare** — sì, ma breve: la regola "un fornitore già disattivato non si disattiva di nuovo"
   va nell'aggregato (`Supplier.Deactivate()`), non nell'handler; le query dei menu a tendina
   filtrano gli attivi.
3. **Implementare** — `/new-slice` *(in arrivo)*: comando `DeactivateSupplier`, endpoint, permesso,
   azione nello store e pulsante nella pagina.
4. **Verificare** — più un test dell'invariante in `Domain.Tests`.
5. **Revisionare** — `architecture-security-reviewer`: un endpoint nuovo con un permesso.
   Nessuna modifica allo schema, quindi niente ef-sql.
6. **Chiudere** — messaggio proposto: `feat: disattivazione dei fornitori`.

### Un bug

> "Nel dialog dei fornitori, se il salvataggio fallisce il dialog si chiude lo stesso."

1. **Capire** — `/fix` con la descrizione. Il lead legge dialog, store e service: l'azione di
   scrittura usa `run` invece di `runOrThrow`, quindi l'errore non arriva al dialog.
2. **Pianificare** — no: la causa è chiara e la correzione è in un file.
3. **Implementare** — `runOrThrow` nello store. Il lead controlla se lo stesso errore c'è in altri
   store, e lo segnala invece di correggerlo in silenzio.
4. **Verificare** — più un test dello store che dimostra che l'errore viene rilanciato: è il test che
   avrebbe intercettato il bug.
5. **Revisionare** — `/review` sul diff; nessun reviewer specialistico.
6. **Chiudere** — messaggio proposto: `fix: il dialog fornitori resta aperto se il salvataggio fallisce`.

## Quando il ciclo si accorcia

| Modifica | Passi |
|---|---|
| Un testo, una traduzione, uno stile | Capire → Implementare → Verificare → Chiudere |
| Un fix confinato e con causa chiara | Capire → Implementare → Verificare (con il test che lo dimostra) → `/review` → Chiudere |
| Un campo in più | Capire → `/add-field` → Verificare → `ef-sql-reviewer` se la tabella ha già dati → Chiudere |
| Tutto il resto | Il ciclo completo |

Il passo che non si accorcia mai è la verifica.

## Da qui

- **[Il modello di lavoro](come-lavora.md)** — i componenti e le ragioni delle scelte
- **[Lavorare con Claude](lavorare-con-claude.md)** — che cosa controllare tu, passo per passo
- **[I subagenti](subagenti.md)** — che cosa ricevono i reviewer e che cosa restituiscono
- **[Aggiungere una feature](../guide/nuova-feature.md)** — il percorso di `/new-feature` spiegato per
  esteso, utile per rivederne l'output
- **[Testare il backend](../guide/test-backend.md)** — che cosa si testa dove
