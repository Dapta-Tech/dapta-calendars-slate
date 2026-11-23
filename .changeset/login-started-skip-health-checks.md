---
'@slate/web': patch
---

`calendars_login_started` is no longer sent for health checks. The kubelet's probe of `/` follows the root's same-host redirect into the login route, so each pod's probes were recording a start about once every few seconds; `kube-probe`, `ELB-HealthChecker`, `GoogleHC` and uptime monitors now count as automated clients, like crawlers and link previewers.
