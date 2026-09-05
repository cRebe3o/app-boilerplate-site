# Documentazione app-boilerplate

**app-boilerplate** è un template [Copier](https://copier.readthedocs.io) da cui nascono
applicazioni gestionali già impiantate: un monorepo con **API .NET 10** organizzata a vertical
slice e **frontend Vue 3 + Vuetify**, che gira indifferentemente su **SQL Server o PostgreSQL**
(via Entity Framework Core) e autentica gli utenti con credenziali locali, con **Azure AD** o con
l'**identità Windows**.

Il template non porta un dominio applicativo: porta tutto ciò che in un gestionale viene *prima*
del dominio — accesso, utenti, gruppi, ruoli e permessi, audit log, log degli errori,
configurazione di sistema, monitoraggio del database. Le feature del progetto si aggiungono sopra,
seguendo il pattern già presente.

Queste pagine descrivono com'è fatto un progetto generato e come ci si lavora sopra. Sono la
documentazione del template: la fonte di verità ultima resta il codice del repository
`app-boilerplate`, e ogni pagina rimanda ai file che descrive.

Se non sai da dove partire, comincia dalla [Panoramica](progetto/panoramica.html).

<!--CARDS-->
