# Documentazione DelVoltone

DelVoltone è un gestionale di catalogo prodotti: un monorepo con **API .NET 10** organizzata a
vertical slice e **frontend Vue 3**, che gira indifferentemente su **SQL Server o PostgreSQL**
(via Entity Framework Core) e autentica gli utenti con credenziali locali o con **Azure AD**.

> **Nota.** Il supporto a MongoDB è stato rimosso a luglio 2026: oggi l'applicazione si collega
> **solo a database SQL**. La documentazione della vecchia architettura dual MongoDB/SQL Server è
> conservata come storico nella sezione *Database — versione storica*.

Queste pagine descrivono come è fatto e come si lavora sopra. Sono la documentazione di progetto:
la fonte di verità ultima resta il codice in [`del-voltone`](https://github.com/cRebe3o/del-voltone),
e ogni pagina rimanda ai file che descrive.

Se non sai da dove partire, comincia dalla [Panoramica](progetto/panoramica.html).

<!--CARDS-->
