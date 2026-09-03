`imageseg-overview.json` is loaded automatically (see dashboards.yml, 30s poll interval - no
restart needed) - four rows: HTTP (request rate/latency/errors, rate-limit rejections),
Pipeline (pending backlog, in-flight, claim rate, task outcomes/duration), AI Sidecar
(segment/regions rate+latency, model readiness), .NET runtime (GC, working set).

Drop any other dashboard JSON in here too and Grafana picks it up the same way. Two easy
starting points if you want more depth than the bundled one:

- ASP.NET Core: https://grafana.com/grafana/dashboards/19924 (works with prometheus-net's
  http_request_duration_seconds/http_requests_received_total naming)
- FastAPI/Starlette: https://grafana.com/grafana/dashboards/16110

Import via dashboard ID in the Grafana UI, or download the JSON and place it directly in this
folder.
