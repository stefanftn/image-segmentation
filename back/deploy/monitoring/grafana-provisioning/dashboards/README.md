Drop dashboard JSON files here and Grafana picks them up automatically (see dashboards.yml,
30s poll interval - no restart needed). Two easy starting points:

- ASP.NET Core: https://grafana.com/grafana/dashboards/19924 (works with prometheus-net's
  http_request_duration_seconds/http_requests_received_total naming)
- FastAPI/Starlette: https://grafana.com/grafana/dashboards/16110

Import via dashboard ID in the Grafana UI, or download the JSON and place it directly in this
folder.
