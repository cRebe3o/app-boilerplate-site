# Lavorare con Claude

Le altre pagine di questa sezione descrivono l'organizzazione dal punto di vista di Claude. Questa
è dal tuo: come chiedere una modifica, che cosa controllare nei momenti in cui Claude si ferma,
come correggere la rotta e come tenere una sessione in buono stato.

## Aprire la sessione

Apri Claude Code **nella root del monorepo**, non in `apps/backend` o `apps/frontend`. Da lì:

- vale il `.claude/` del progetto: skill, comandi, permessi;
- si carica il `CLAUDE.md` di root, e quelli delle app quando Claude ci entra;
- una modifica che attraversa backend e frontend sta in una sessione sola.

Prima di cominciare, conviene che il working tree sia pulito o su un branch dedicato: alla fine
avrai un diff che contiene solo questa modifica, più facile da rivedere e da committare.

## Chiedere una modifica

Una buona richiesta dice **che cosa deve succedere**, non come scriverlo: il come lo sanno le
istruzioni del progetto.

| Meno efficace | Più efficace |
|---|---|
| "Crea un'entità Supplier con un controller" | "Mi serve l'anagrafica fornitori: ragione sociale, partita IVA univoca, email, attivo sì/no. La vedono tutti, la modificano gli amministratori" |
| "Sistema il dialog" | "Nel dialog dei fornitori, se il salvataggio fallisce il dialog si chiude lo stesso. Deve restare aperto e mostrare l'errore" |
| "Aggiungi un filtro" | "Nella lista fornitori voglio filtrare per attivo/non attivo, insieme alla ricerca che c'è già" |

Che cosa aiuta mettere nella richiesta:

- **il comportamento atteso** dal punto di vista di chi usa l'applicazione;
- **le decisioni che hai già preso**: chi può fare che cosa, se la cancellazione è logica, se ci
  sono dati esistenti da migrare;
- **un riferimento**, se ne hai uno: "come la pagina dei gruppi";
- **per un bug, come si riproduce** e che cosa succede invece di ciò che ti aspetti.

Se manca una decisione che spetta a te, Claude te la chiede prima di scrivere codice
(vedi [Capire](ciclo-di-una-modifica.md#1-capire)). Se ti accorgi di non saperla prendere, dillo:
Claude può presentarti le alternative con le conseguenze, ma la scelta resta tua.

## Comando o richiesta libera?

| Se devi… | Usa |
|---|---|
| Creare un'entità nuova con tutto il CRUD | `/new-feature <Entità>` |
| Aggiungere o togliere un campo ovunque | `/add-field`, `/remove-field` |
| Correggere un bug descritto a parole | `/fix` |
| Rivedere ciò che hai o che ha scritto Claude | `/review` |
| Tutto il resto | Una richiesta in linguaggio naturale: le skill giuste si attivano da sole |

I comandi sono descritti in [Le skill e i comandi](skill.md#i-comandi).

## I momenti in cui Claude si ferma

Ci sono tre punti in cui il lavoro aspetta te. Sono anche i tre punti in cui un tuo controllo
rende di più.

### Le domande

Rispondi a tutte, anche con "scegli tu il default": a quel punto Claude usa il default del
progetto e lo scrive nel riepilogo, così resta visibile.

### Il piano

Quando Claude propone un piano (vedi [Pianificare](ciclo-di-una-modifica.md#2-pianificare)), è il
momento più economico per correggerlo: cambiare una riga del piano costa un minuto, cambiare il
codice dopo costa un giro intero. Controlla soprattutto:

- **i permessi**: nomi e ruoli a cui vanno;
- **le migration**: se toccano dati esistenti, e come;
- **dove sta la logica**: una regola di business deve stare nell'aggregato, non nell'handler o
  nella pagina;
- **che cosa non c'è**: una pagina che ti aspettavi, un filtro, un test.

Se qualcosa non va, rispondi con la correzione invece di approvare: Claude rivede il piano e te lo
ripropone.

### Il riepilogo finale

A fine lavoro Claude ti consegna i file toccati, l'esito dei controlli, le segnalazioni dei reviewer
con ciò che ne ha fatto, e un messaggio di commit proposto (vedi [Chiudere](ciclo-di-una-modifica.md#6-chiudere)).
Prima di committare:

- **leggi il diff**, almeno nelle parti che toccano dominio, permessi e migration;
- **guarda l'esito dei controlli**: se Claude dice che un controllo è rosso per una ragione esterna,
  verifica che lo sia davvero;
- **prova l'applicazione** sul caso che hai chiesto: i test dicono che il codice fa ciò che i test
  verificano, non che fa ciò che volevi.

## Correggere la rotta

Puoi interrompere Claude in qualsiasi momento (Esc) e scrivere una correzione. Conviene farlo
appena vedi che va nella direzione sbagliata, non alla fine.

- **"No, così no"** non basta: di' che cosa è sbagliato e che cosa vuoi invece. "Il filtro va lato
  server, non nello store" è una correzione che Claude può applicare.
- **Se la stessa correzione ti serve due volte**, non è un problema di questa sessione: è
  un'istruzione che manca. Va scritta dove serve (vedi [Le istruzioni](istruzioni.md#dove-va-una-regola-nuova)),
  così la terza volta non succede.
- **Se la modifica è andata troppo lontano**, è più rapido scartarla e ripartire con una richiesta
  migliore che correggerla un pezzo alla volta. Le modifiche sono nel working tree: le scarti con
  git, che usi tu.

## Tenere in buono stato la sessione

Claude lavora dentro un contesto di dimensione limitata: ogni file letto, ogni output di test, ogni
scambio lo riempie. Quando è pieno, la parte vecchia viene riassunta e i dettagli si perdono.

- **Una sessione, un compito.** Finita una modifica e committata, inizia una sessione nuova
  (`/clear`) per la successiva. Il contesto della modifica precedente non serve più e occupa
  spazio.
- **Le ricerche larghe vanno a Explore**: è il motivo per cui esiste
  (vedi [I subagenti](subagenti.md#explore)). Se chiedi "dove si usa X in tutto il progetto?",
  Claude dovrebbe delegarla da sé; puoi anche chiederlo esplicitamente.
- **Non incollare log interi**: incolla l'errore e le righe intorno. Se serve di più, Claude lo
  chiede o lo legge da sé.
- **Le cose da ricordare oltre la sessione** non stanno nella conversazione: stanno nei
  `CLAUDE.md`, nelle skill, nel codice. Ciò che dici a Claude oggi, domani non lo sa più.

## Che cosa non chiedere

- **Di modificare i file generati o i segreti**: `api.generated.ts`, le migration committate,
  `appsettings.local.json`. Claude rifiuta e propone la strada giusta, e gli
  [hook](permessi-e-hook.md#gli-hook) lo impediscono comunque.
- **Di saltare la verifica "perché è una modifica piccola"**: le modifiche piccole sono quelle che
  rompono i test di architettura senza che nessuno se lo aspetti.
- **Di committare e pushare in automatico a fine lavoro**, come abitudine. Puoi chiederlo per una
  singola modifica, ma la revisione del diff prima del commit è il tuo controllo, e saltarlo
  toglie l'ultimo livello.

## Da qui

- **[Il ciclo di una modifica](ciclo-di-una-modifica.md)** — gli stessi passi visti da Claude
- **[Le skill e i comandi](skill.md)** — che cosa puoi invocare
- **[Permessi e hook](permessi-e-hook.md)** — che cosa Claude può fare senza chiederti
