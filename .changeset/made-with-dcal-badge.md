---
"@slate/shared": patch
"@slate/notifications": patch
"@slate/config": patch
---

The public attribution pill now reads "Made with dCal.ai by Dapta" ("Hecho con
dCal.ai de Dapta"), naming the product and the company the way dForms signs its
forms, on the booking pages and in the invitee emails. The free-calendar line
and the branding setting's hint say dCal as well. A fork's pill, free-calendar line and
email footer keep naming the fork's own product (`Made with {product}`; the API
reads `PRODUCT_NAME`, else the mail sender name), never dCal or Dapta.
